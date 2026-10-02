import type { PermissionAsk } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeSession, Script } from "../testing/fakeSession.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const services = () => w.h.majhi.services;
const live = () => services().room.getLive("ACM-1", "acme-builder");
const runs = () => services().runs;
const send = (text: string, extra: Record<string, unknown> = {}) =>
  w.h.cmd("room.send", { task: "ACM-1", text, ...extra });

/** Items of the task in the order they appeared. */
async function items(task = "ACM-1"): Promise<RoomItem[]> {
  const page = await w.h.cmd("room.items", { task, limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
}
const texts = async () =>
  (await items()).map((i) =>
    i.type === "owner" || i.type === "agent" || i.type === "system" ? `${i.type}: ${i.text}` : i.type,
  );

async function until(check: () => boolean | Promise<boolean>, what = "condition"): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A turn that stays open until `open.release()`. */
function gated(): { script: Script; release: () => void } {
  let release: () => void = () => {};
  const open = new Promise<void>((r) => {
    release = r;
  });
  return {
    release: () => release(),
    script: async (turn) => {
      turn.emit({ type: "text", messageId: "m", text: "working" });
      await Promise.race([open, turn.untilCancelled()]);
      return "end_turn";
    },
  };
}

/** Starts the task with the first session scripted, and waits for that session's brief turn to begin. */
async function started(script?: Script): Promise<FakeSession> {
  w = await taskWorld();
  if (script !== undefined) {
    // Only the first session: later ones behave normally.
    w.h.runtime.onSession = (session) => {
      if (w.h.runtime.sessions.length === 0) session.script = script;
    };
  }
  const res = await w.h.cmd("tasks.create", {
    text: "fix api",
    repos: [{ project: "acme-api" }],
    start: true,
  });
  expect(res.status).toBe(200);
  await until(
    () => w.h.runtime.sessions.length > 0 && w.h.runtime.sessions[0]?.prompts.length === 1,
    "first prompt",
  );
  const session = w.h.runtime.sessions[0];
  if (session === undefined) throw new Error("no session");
  return session;
}

/** A permission request. A field set to `undefined` is left out. */
const ask = (over: { [K in keyof PermissionAsk]?: PermissionAsk[K] | undefined } = {}): PermissionAsk => {
  const full: Record<string, unknown> = {
    title: "Run npm test",
    kind: "execute",
    command: "npm test",
    toolCallId: "t1",
    options: [
      { id: "allow", name: "Allow", kind: "allow_once" },
      { id: "always", name: "Allow for this task", kind: "allow_always" },
      { id: "reject", name: "Deny", kind: "reject_once" },
    ],
    ...over,
  };
  for (const key of Object.keys(full)) if (full[key] === undefined) delete full[key];
  return full as unknown as PermissionAsk;
};

describe("messages while the agent works", () => {
  it("interrupts: cancels the turn, then sends the message first", async () => {
    const g = gated();
    const session = await started(g.script);
    await send("queued one");
    session.script = async () => "end_turn";
    const res = await send("urgent", { mode: "interrupt" });
    expect(res.body.item.queued).toBe(false);
    await runs().idle();
    expect(session.cancels).toBe(1);
    expect(session.prompts.map((p) => (p[0]?.type === "text" ? p[0].text : ""))).toEqual([
      expect.stringContaining("Read TASK.md"),
      "urgent",
      "queued one",
    ]);
    expect(await texts()).toContain("system: Stopped @acme-builder's turn.");
  });
});

describe("permissions", () => {
  it("asks the owner when the perms do not cover it, and waits", async () => {
    let answer: string | undefined = "unset";
    await started(async (turn) => {
      answer = await turn.ask(ask({ title: "git push origin main", command: "git push origin main" }));
      return "end_turn";
    });
    await until(() => live()?.status === "waiting", "waiting");
    const pending = (await items()).find((i) => i.type === "permission") as Extract<
      RoomItem,
      { type: "permission" }
    >;
    expect(pending.state).toBe("pending");
    expect(answer).toBe("unset");

    const res = await w.h.cmd("room.permission", { task: "ACM-1", item: pending.id, option: "reject" });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ state: "answered", chosen: "reject" });
    await runs().idle();
    expect(answer).toBe("reject");
    expect(services().store.permissions.audit("ACM-1")).toMatchObject([
      { decision: "deny", by: "owner", kind: "execute" },
    ]);
    // It cannot be answered twice, and options must exist.
    expect(
      (await w.h.cmd("room.permission", { task: "ACM-1", item: pending.id, option: "allow" })).status,
    ).toBe(409);
  });

  it("remembers allow for this task per kind, but never for pushes", async () => {
    const answers: (string | undefined)[] = [];
    const g = gated();
    await started(async (turn) => {
      answers.push(await turn.ask(ask({ kind: "other", title: "Use a tool", command: undefined })));
      answers.push(
        await turn.ask(
          ask({ kind: "other", title: "Use a tool again", command: undefined, toolCallId: "t2" }),
        ),
      );
      answers.push(
        await turn.ask(ask({ kind: "execute", title: "git push", command: "git push", toolCallId: "t3" })),
      );
      return g.script(turn);
    });
    await until(() => live()?.status === "waiting", "first prompt");
    const first = (await items()).find((i) => i.type === "permission") as RoomItem;
    expect(
      (await w.h.cmd("room.permission", { task: "ACM-1", item: first.id, option: "always" })).status,
    ).toBe(200);
    await until(() => answers.length === 2 && live()?.status === "waiting", "push prompt");
    expect(answers).toEqual(["always", "allow"]);
    const states = (await items())
      .filter((i) => i.type === "permission")
      .map((i) => (i as { state: string }).state);
    expect(states).toEqual(["answered", "auto", "pending"]);
    expect(services().store.permissions.allowed("ACM-1", "other")).toBe(true);
    expect(services().store.permissions.allowed("ACM-1", "execute")).toBe(false);
    g.release();
    await w.h.cmd("room.cancel", { task: "ACM-1" });
    await runs().idle();
  });

  it("allows nothing beyond reads for an agent with no perms", async () => {
    w = await taskWorld({ agent: { perms: [] } });
    const answers: (string | undefined)[] = [];
    w.h.runtime.onSession = (s) => {
      s.script = async (turn) => {
        answers.push(await turn.ask(ask({ kind: "read", title: "Read", command: undefined })));
        answers.push(
          await turn.ask(ask({ kind: "edit", title: "Edit a.ts", command: undefined, toolCallId: "t2" })),
        );
        return "end_turn";
      };
    };
    await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true });
    await until(() => live()?.status === "waiting", "edit prompt");
    expect(answers).toEqual(["allow"]);
    await w.h.cmd("room.cancel", { task: "ACM-1" });
  });
});

describe("failures and restarts", () => {
  it("posts an error when a turn fails, and starts a new session, resuming the old one, on the next message", async () => {
    const session = await started(async () => {
      throw new Error("boom");
    });
    await runs().idle();
    expect(live()).toMatchObject({ status: "error" });
    expect(await texts()).toContain("system: @acme-builder failed: boom");
    expect(session.closed).toBe(true);

    await send("try again");
    await runs().idle();
    expect(w.h.runtime.starts[1]?.resume).toBe(session.sessionId);
    expect(w.h.runtime.sessions).toHaveLength(2);
    const second = w.h.runtime.sessions[1];
    // The session id matched, so it counts as resumed: no TASK.md reminder.
    expect(second?.prompts[0]).toEqual([{ type: "text", text: "try again" }]);
    expect(await texts()).toContain(
      "system: @acme-builder resumed on claude-acme, model sonnet, effort high",
    );
    expect(live()?.status).toBe("idle");
    expect(w.h.runtime.sessions[0]).not.toBe(second);
  });

  it("marks live runs ended on start, cancels stale prompts and shows agents as stopped", async () => {
    let waiting = true;
    await started(async (turn) => {
      await turn.ask(ask({ kind: "other", title: "Odd", command: undefined }));
      waiting = false;
      return "end_turn";
    });
    await until(() => live()?.status === "waiting", "waiting");
    // A restart: a new server over the same home. The old one is abandoned like a crash.
    const fresh = w.h.restart();
    try {
      const svc = fresh.majhi.services;
      expect(svc.store.runs.forTask("ACM-1")[0]).toMatchObject({ stopReason: "server-restart" });
      const perm = svc.store.room.page("ACM-1", 50).items.find((i) => i.type === "permission");
      expect(perm).toMatchObject({ state: "cancelled" });
      const snapshot = svc.tasks.snapshot("ACM-1");
      expect(snapshot?.agents).toEqual([
        { agent: "acme-builder", status: "stopped", queued: 0, commands: [] },
      ]);
      expect(waiting).toBe(true);
    } finally {
      await fresh.cleanup().catch(() => undefined);
    }
  });
});

describe("start-up messages", () => {
  it("refuses an account of another org", async () => {
    w = await taskWorld();
    await w.h.cmd("orgs.create", { id: "beta", name: "Beta" });
    await w.h.cmd("accounts.create", { id: "claude-beta", tool: "claude", org: "beta", auth: "login" });
    await w.h.cmd("agents.update", {
      id: "acme-builder",
      frontmatter: { scope: "acme", role: "Builder", account: "claude-beta", perms: ["edit"] },
      instructions: "",
    });
    await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true });
    await runs().idle();
    // The start fails for good: the task pauses and its card says why.
    const card = (await items()).find((i) => i.type === "paused");
    expect(card).toMatchObject({
      reason: "error",
      why: '@acme-builder works in "acme" and cannot use the account of "beta".',
    });
    expect(w.h.runtime.starts).toHaveLength(0);
  });
});
