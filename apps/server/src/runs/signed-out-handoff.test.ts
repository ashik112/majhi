import { afterEach, describe, expect, it } from "vitest";
import type { Script } from "../testing/fakeSession.ts";
import { taskWorld, type World } from "../testing/world.ts";

/**
 * A lead whose account is signed out (5.18): the work moves to the agent's fallback, or to a
 * teammate whose account works, like it does at a usage limit. Without one the task pauses
 * `signed-out` and goes on once the account is back. In-memory sessions; no tokens are spent.
 */

let w: World;
afterEach(() => w?.cleanup());

const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** The turn fails the way Claude Code's does when its sign-in expired. */
const signedOutTurn: Script = async (turn) => {
  turn.emit({
    type: "text",
    messageId: "auth",
    text: "Failed to authenticate: OAuth session expired and could not be refreshed",
  });
  throw Object.assign(new Error("Authentication required"), { code: -32000 });
};

interface Options {
  /** The builder's fallback is `acme-backup`, on its own account. */
  fallback?: boolean;
  org?: Record<string, unknown>;
}

/** Acme with `acme-builder` (account claude-acme) and `acme-backup` (account claude-acme-2). */
async function world(options: Options = {}): Promise<World> {
  w = await taskWorld();
  await ok("accounts.create", { id: "claude-acme-2", tool: "claude", org: "acme", auth: "login" });
  await ok("agents.create", {
    id: "acme-backup",
    frontmatter: { scope: "acme", role: "Builder", account: "claude-acme-2", perms: ["edit", "shell"] },
    instructions: "Back things up.\n",
  });
  if (options.fallback !== false) {
    await ok("agents.edit", { id: "acme-builder", set: { fallback: "acme-backup" } });
  }
  if (options.org !== undefined) await ok("orgs.update", { id: "acme", ...options.org });
  return w;
}

async function ok(name: string, body: unknown): Promise<unknown> {
  const res = await w.h.cmd(name, body);
  if (res.status !== 200) throw new Error(`${name} failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

const runtime = () => w.h.runtime;
const services = () => w.h.majhi.services;
const task = async () => (await w.h.cmd("tasks.get", { id: "ACM-1" })).body;

/** Sessions of the builder's account fail on their first turn; the others keep the default script. */
function builderSignedOut(): void {
  runtime().onSession = (session, start) => {
    if (start.account.home.endsWith("claude-acme")) session.script = signedOutTurn;
  };
}

const startTask = (team?: string[]) =>
  ok("tasks.create", {
    text: "fix api",
    repos: [{ project: "acme-api" }],
    start: true,
    ...(team === undefined ? { agent: "acme-builder" } : { team }),
  });

const promptText = (session: { prompts: { type: string; text?: string }[][] } | undefined) =>
  (session?.prompts[0] ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");

describe("a lead whose account is signed out", () => {
  it("hands the task to its fallback, which runs it from a handoff note", async () => {
    await world();
    builderSignedOut();
    await startTask();
    await until(
      () => runtime().sessions.some((s) => s.prompts.length > 0 && !s.closed),
      "the fallback's turn",
    );

    expect((await task()).team).toEqual(["acme-backup"]);
    expect((await task()).status).not.toBe("paused");
    expect(promptText(runtime().sessions.at(-1))).toContain("# Handoff note");
    expect(promptText(runtime().sessions.at(-1))).toContain("Read TASK.md");
    const view = (await services().accounts.list()).find((a) => a.id === "claude-acme");
    expect(view?.status).toBe("needs-login");
  });

  it("hands the task to a teammate whose account works when it has no fallback", async () => {
    await world({ fallback: false });
    builderSignedOut();
    await startTask(["acme-builder", "acme-backup"]);
    await until(
      async () => (await task()).team[0] === "acme-backup" && runtime().sessions.at(-1)?.prompts.length === 1,
      "the teammate's turn",
    );

    expect((await task()).team).toEqual(["acme-backup"]);
    expect((await task()).status).not.toBe("paused");
  });

  it("hands over when the agent cannot start, not only when a turn fails", async () => {
    await world();
    runtime().signedOutHomes = ["claude-acme"];
    await startTask();
    await until(
      async () => (await task()).team[0] === "acme-backup" && runtime().sessions.length === 1,
      "the fallback's session",
    );
    await until(() => runtime().sessions[0]?.prompts.length === 1, "the fallback's turn");
    expect((await task()).status).not.toBe("paused");
  });

  it("pauses signed out when there is no fallback and no teammate, and continues once signed in", async () => {
    await world({ fallback: false });
    builderSignedOut();
    await startTask();
    await until(async () => (await task()).status === "paused", "the pause");

    expect(await task()).toMatchObject({ pausedReason: "signed-out", team: ["acme-builder"] });
    const sessions = runtime().sessions.length;

    // The account works again: the sweep resumes the task with the same prompt.
    runtime().onSession = undefined;
    // The sign-in failure the turn found holds until a usage read proves the sign-in works.
    runtime().usage = { models: [], estimated: false, updatedAt: new Date().toISOString() };
    await services().resilience.checkSignIns();
    await until(() => runtime().sessions.length > sessions, "the resumed session");
    await until(async () => (await task()).status !== "paused", "the task running again");
    expect((await task()).team).toEqual(["acme-builder"]);
  });

  it("pauses instead of handing off when the org turned the handoff off", async () => {
    await world({ org: { resume: { handoff: false } } });
    builderSignedOut();
    await startTask();
    await until(async () => (await task()).status === "paused", "the pause");

    expect(await task()).toMatchObject({ pausedReason: "signed-out", team: ["acme-builder"] });
    expect(runtime().sessions).toHaveLength(1);
  });

  it("pauses when the fallback's account is signed out too", async () => {
    await world();
    await services().accounts.markSignedOut("claude-acme-2", "Signed out");
    builderSignedOut();
    await startTask();
    await until(async () => (await task()).status === "paused", "the pause");

    expect(await task()).toMatchObject({ pausedReason: "signed-out", team: ["acme-builder"] });
    expect(runtime().sessions).toHaveLength(1);
  });

  it("pauses when it cannot start and the fallback's account is signed out too", async () => {
    await world();
    await services().accounts.markSignedOut("claude-acme-2", "Signed out");
    runtime().signedOutHomes = ["claude-acme", "claude-acme-2"];
    await startTask();
    await until(async () => (await task()).status === "paused", "the pause");

    expect(await task()).toMatchObject({ pausedReason: "signed-out", team: ["acme-builder"] });
  });
});
