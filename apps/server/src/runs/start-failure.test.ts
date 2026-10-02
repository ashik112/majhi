import { basename } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { failedHealth, OK_HEALTH } from "../testing/fakeRuntime.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { classifyStartFailure } from "./start-failure.ts";

let w: World;
afterEach(() => w?.cleanup());

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const task = async () => (await w.h.cmd("tasks.get", { id: "ACM-1" })).body;

async function items(): Promise<RoomItem[]> {
  const page = await w.h.cmd("room.items", { task: "ACM-1", limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => a.seq - b.seq);
}

const create = (team?: string[]) =>
  w.h.cmd("tasks.create", {
    text: "fix api",
    repos: [{ project: "acme-api" }],
    ...(team === undefined ? {} : { team }),
    start: true,
  });

describe("a task whose agents cannot start", () => {
  it("pauses signed out, with the fix in words, and resumes by itself once the account is healthy", async () => {
    w = await taskWorld();
    const { h } = w;
    h.runtime.startError = new Error("Not logged in. Run /login");
    h.runtime.probe = { ...h.runtime.probe, health: failedHealth("auth") };
    expect((await create()).status).toBe(200);
    await until(async () => (await task()).status === "paused", "the pause");

    expect(await task()).toMatchObject({ status: "paused", pausedReason: "signed-out" });
    const card = (await items()).find((i) => i.type === "paused");
    expect(card).toMatchObject({
      reason: "signed-out",
      state: "pending",
      why: "claude-acme is signed out. Sign in, then resume.",
    });
    expect(h.majhi.services.room.getLive("ACM-1", "acme-builder")).toMatchObject({
      status: "paused",
      couldNotStart: true,
    });

    // Still signed out: nothing changes.
    await h.majhi.services.resilience.checkSignIns();
    expect((await task()).status).toBe("paused");

    // Signed in again: the sweep resumes the task and the agent starts.
    h.runtime.startError = undefined;
    h.runtime.probe = { ...h.runtime.probe, health: OK_HEALTH };
    await h.majhi.services.resilience.checkSignIns();
    await until(() => h.runtime.sessions.length > 0, "the session");
    expect(await task()).toMatchObject({ status: "running" });
    expect(h.majhi.services.room.getLive("ACM-1", "acme-builder")?.couldNotStart).toBeUndefined();
  });

  it("pauses with the first line of an error, and Resume tries to start again", async () => {
    w = await taskWorld();
    const { h } = w;
    h.runtime.startError = new Error("adapter crashed on start\n    at boot (adapter.js:1)");
    expect((await create()).status).toBe(200);
    await until(async () => (await task()).status === "paused", "the pause");

    expect(await task()).toMatchObject({ pausedReason: "error" });
    expect((await items()).find((i) => i.type === "paused")).toMatchObject({
      why: "adapter crashed on start",
    });
    // A start that failed for good is not retried by the sign-in sweep.
    await h.majhi.services.resilience.checkSignIns();
    expect((await task()).status).toBe("paused");

    h.runtime.startError = undefined;
    expect((await h.cmd("tasks.start", { id: "ACM-1" })).status).toBe(200);
    await until(() => h.runtime.sessions.length > 0, "the session");
    expect((await task()).status).toBe("running");
  });

  it("keeps running when one agent of a team cannot start and another works", async () => {
    w = await taskWorld();
    const { h } = w;
    const must = async (name: string, body: unknown) => {
      const res = await h.cmd(name, body);
      if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
    };
    await must("accounts.create", { id: "codex-acme", tool: "codex", org: "acme", auth: "login" });
    await must("agents.create", {
      id: "acme-lead",
      frontmatter: { scope: "acme", role: "Lead", account: "codex-acme", perms: ["edit", "shell"] },
      instructions: "Plan and delegate.\n",
    });
    // The builder's account fails to start; the lead's turn stays open.
    const start = h.runtime.startSession.bind(h.runtime);
    h.runtime.startSession = async (input) => {
      if (basename(input.account.home) === "claude-acme") throw new Error("Not logged in");
      return start(input);
    };
    h.runtime.onSession = (session) => {
      session.script = async (turn) => {
        await turn.untilCancelled();
        return "cancelled";
      };
    };
    h.runtime.probe = { ...h.runtime.probe, health: failedHealth("auth") };
    expect((await create(["acme-lead", "acme-builder"])).status).toBe(200);
    await until(() => h.runtime.sessions[0]?.prompts.length === 1, "the lead's turn");

    expect(
      (await h.cmd("room.send", { task: "ACM-1", text: "@acme-builder start on the tests" })).status,
    ).toBe(200);
    await until(
      () => h.majhi.services.room.getLive("ACM-1", "acme-builder")?.couldNotStart === true,
      "the builder's failed start",
    );

    expect(await task()).toMatchObject({ status: "running" });
    expect((await task()).pausedReason).toBeUndefined();
    const texts = (await items()).flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(texts).toContain("@acme-builder is out: claude-acme is signed out. Sign in, then resume.");
    expect((await items()).some((i) => i.type === "paused")).toBe(false);
  });
});

describe("classifying a failed start", () => {
  const probe = (status: "needs-login" | "at-limit" | "healthy", resetsAt?: string) => ({ status, resetsAt });

  it("trusts the account's state over the wording of the error", () => {
    expect(
      classifyStartFailure({ account: "claude-acme", message: "boom", probe: probe("needs-login") }),
    ).toEqual({
      kind: "signed-out",
      text: "claude-acme is signed out. Sign in, then resume.",
    });
    expect(
      classifyStartFailure({
        account: "claude-acme",
        message: "Invalid credentials",
        probe: probe("healthy"),
      }).kind,
    ).toBe("signed-out");
  });

  it("names the time an account at its limit comes back", () => {
    const resetsAt = new Date(2026, 9, 2, 15, 40).toISOString();
    expect(
      classifyStartFailure({ account: "claude-acme", message: "boom", probe: probe("at-limit", resetsAt) }),
    ).toEqual({
      kind: "limit",
      text: "claude-acme is at its limit until 3:40 PM",
    });
    expect(
      classifyStartFailure({ account: "claude-acme", message: "usage limit reached", probe: undefined }).text,
    ).toBe("claude-acme is at its limit");
  });

  it("keeps the first line of any other error", () => {
    expect(
      classifyStartFailure({
        account: "claude-acme",
        message: "image majhi-runner not found\nmore",
        probe: undefined,
      }),
    ).toEqual({ kind: "error", text: "image majhi-runner not found" });
    expect(
      classifyStartFailure({ account: undefined, message: "Not logged in", probe: undefined }).kind,
    ).toBe("error");
  });
});
