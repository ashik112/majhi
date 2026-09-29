import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  const res = await w.h.cmd("tasks.create", { text: "fix api", start: true });
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

describe("streaming into the room", () => {
  it("merges text per message, updates tools and the plan in place, and tracks what the agent does now", async () => {
    const g = gated();
    const session = await started(async (turn) => {
      turn.emit({ type: "thought", messageId: "th", text: "hmm " });
      turn.emit({ type: "thought", messageId: "th", text: "ok" });
      turn.emit({ type: "text", messageId: "m1", text: "Hello " });
      turn.emit({ type: "text", messageId: "m1", text: "world" });
      turn.emit({
        type: "plan",
        entries: [
          { content: "Write test", status: "in_progress" },
          { content: "Ship", status: "pending" },
        ],
      });
      turn.emit({
        type: "tool",
        toolCallId: "c1",
        title: "Read README.md",
        kind: "read",
        status: "in_progress",
        locations: ["README.md"],
      });
      return g.script(turn);
    });
    await until(() => live()?.nowDoing === "Read README.md", "nowDoing");
    expect(live()).toMatchObject({ status: "working", nowDoing: "Read README.md" });
    session.emit({
      type: "tool",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "diff", path: "a.ts", newText: "x" }],
    });
    session.emit({
      type: "tool",
      toolCallId: "c2",
      title: "Run npm test",
      kind: "execute",
      status: "in_progress",
    });
    session.emit({ type: "usage", used: 1200, size: 200000 });
    session.emit({ type: "commands", commands: [{ name: "compact", description: "Compact" }] });
    session.emit({ type: "config", model: "opus" });
    expect(live()).toMatchObject({
      nowDoing: "Run npm test",
      usage: { used: 1200, size: 200000 },
      commands: [{ name: "compact", description: "Compact" }],
      model: "opus",
    });
    g.release();
    await runs().idle();

    const all = await items();
    const byType = (t: string) => all.filter((i) => i.type === t);
    expect(byType("agent").map((i) => (i as { text: string }).text)).toEqual(["Hello world", "working"]);
    expect(byType("thought").map((i) => (i as { text: string }).text)).toEqual(["hmm ok"]);
    const tools = byType("tool") as Extract<RoomItem, { type: "tool" }>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      toolCallId: "c1",
      title: "Read README.md",
      kind: "read",
      status: "completed",
      locations: ["README.md"],
      content: [{ type: "diff", path: "a.ts", newText: "x" }],
    });
    expect(byType("plan")).toHaveLength(1);
    expect(live()).toMatchObject({ status: "idle" });
    expect(live()?.nowDoing).toBeUndefined();
    // Seq grows with every write and ids never repeat.
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
  });

  it("cuts long terminal output in the middle", async () => {
    await started(async (turn) => {
      turn.emit({
        type: "tool",
        toolCallId: "c1",
        title: "npm test",
        kind: "execute",
        status: "completed",
        content: [{ type: "terminal", output: `${"a".repeat(20000)}${"z".repeat(20000)}`, exitCode: 0 }],
      });
      return "end_turn";
    });
    await runs().idle();
    const tool = (await items()).find((i) => i.type === "tool") as Extract<RoomItem, { type: "tool" }>;
    const content = tool.content[0];
    expect(content?.type === "terminal" && content.output.length).toBeLessThan(16 * 1024 + 60);
    expect(content?.type === "terminal" && content.output.includes("characters cut")).toBe(true);
  });
});

describe("messages while the agent works", () => {
  it("queues a message, marks it queued, and sends it when the turn ends", async () => {
    const g = gated();
    const session = await started(g.script);
    const res = await send("second");
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ type: "owner", text: "second", queued: true, to: "acme-builder" });
    const third = await send("third");
    expect(third.body.item.queued).toBe(true);
    expect(live()?.queued).toBe(2);
    expect(session.prompts).toHaveLength(1);

    session.script = async () => "end_turn";
    g.release();
    await runs().idle();
    expect(session.prompts.map((p) => p[0])).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Read TASK.md") }),
      { type: "text", text: "second" },
      { type: "text", text: "third" },
    ]);
    const owners = (await items()).filter((i) => i.type === "owner") as Extract<
      RoomItem,
      { type: "owner" }
    >[];
    expect(owners.map((o) => [o.text, o.queued])).toEqual([
      ["fix api", false],
      ["second", false],
      ["third", false],
    ]);
    expect(live()).toMatchObject({ status: "idle", queued: 0 });
  });

  it("sends at once when the agent is idle", async () => {
    const session = await started();
    await runs().idle();
    const res = await send("next");
    expect(res.body.item.queued).toBe(false);
    await runs().idle();
    expect(session.prompts).toHaveLength(2);
  });

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

  it("cancels with Esc, and leaves queued messages queued until the next message", async () => {
    const g = gated();
    const session = await started(g.script);
    await send("later");
    const res = await w.h.cmd("room.cancel", { task: "ACM-1" });
    expect(res.body).toEqual({ cancelled: ["acme-builder"] });
    await runs().idle();
    expect(session.prompts).toHaveLength(1);
    expect(live()).toMatchObject({ status: "idle", queued: 1 });
    const queued = (await items()).find((i) => i.type === "owner" && i.text === "later");
    expect(queued).toMatchObject({ queued: true });

    session.script = async () => "end_turn";
    await send("now");
    await runs().idle();
    expect(session.prompts.map((p) => (p[0]?.type === "text" ? p[0].text : ""))).toEqual([
      expect.stringContaining("Read TASK.md"),
      "later",
      "now",
    ]);
  });

  it("cancel with nothing running does nothing", async () => {
    await started();
    await runs().idle();
    expect((await w.h.cmd("room.cancel", { task: "ACM-1" })).body).toEqual({ cancelled: [] });
    expect((await w.h.cmd("room.cancel", { task: "ACM-9" })).status).toBe(404);
  });

  it("refuses an empty message and a message to an agent not on the task", async () => {
    await started();
    await runs().idle();
    expect((await send("  ")).status).toBe(400);
    const wrong = await send("hi", { agent: "ghost" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("@ghost is not on this task.");
  });
});

describe("permissions", () => {
  it("allows what the agent's perms cover, posts an auto item and logs the decision", async () => {
    let answer: string | undefined;
    await started(async (turn) => {
      answer = await turn.ask(ask());
      return "end_turn";
    });
    await runs().idle();
    expect(answer).toBe("allow");
    const perm = (await items()).find((i) => i.type === "permission");
    expect(perm).toMatchObject({
      type: "permission",
      state: "auto",
      chosen: "allow",
      title: "Run npm test",
      toolCallId: "t1",
      agent: "acme-builder",
    });
    expect(services().store.permissions.audit("ACM-1")).toMatchObject([
      { agent: "acme-builder", kind: "execute", title: "Run npm test", decision: "allow", by: "rule" },
    ]);
  });

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

  it("marks pending prompts cancelled when the turn is cancelled", async () => {
    let answer: string | undefined = "unset";
    await started(async (turn) => {
      answer = await turn.ask(ask({ kind: "other", title: "Odd tool", command: undefined }));
      await turn.untilCancelled();
      return "cancelled";
    });
    await until(() => live()?.status === "waiting", "waiting");
    await w.h.cmd("room.cancel", { task: "ACM-1" });
    await runs().idle();
    expect(answer).toBeUndefined();
    expect((await items()).find((i) => i.type === "permission")).toMatchObject({ state: "cancelled" });
    expect(services().store.permissions.audit("ACM-1")).toMatchObject([{ decision: "cancelled" }]);
    expect(live()?.status).toBe("idle");
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
    await w.h.cmd("tasks.create", { text: "fix api", start: true });
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

  it("reminds a fresh session to read TASK.md when the old one could not be loaded", async () => {
    await started(async () => {
      throw new Error("boom");
    });
    await runs().idle();
    w.h.runtime.resumes = false;
    await send("try again");
    await runs().idle();
    const text = w.h.runtime.sessions[1]?.prompts[0]?.[0];
    expect(text).toEqual({
      type: "text",
      text: "First read TASK.md in this folder for the task and its rules.\n\ntry again",
    });
    // A slash command stays whole.
  });

  it("keeps slash commands whole", async () => {
    await started(async () => {
      throw new Error("boom");
    });
    await runs().idle();
    w.h.runtime.resumes = false;
    await send("/compact");
    await runs().idle();
    expect(w.h.runtime.sessions[1]?.prompts[0]?.[0]).toEqual({ type: "text", text: "/compact" });
  });

  it("posts an error and sets the agent to error when the process exits", async () => {
    const g = gated();
    const session = await started(g.script);
    session.emit({ type: "exit", code: 1, error: "out of memory" });
    g.release();
    await runs().idle();
    expect(await texts()).toContain("system: @acme-builder stopped unexpectedly: out of memory");
    expect(live()).toMatchObject({ status: "error" });
    await send("hello?");
    await runs().idle();
    expect(w.h.runtime.sessions).toHaveLength(2);
    expect(live()?.status).toBe("idle");
  });

  it("reports a session that cannot start, keeps the message, and retries on the next send", async () => {
    w = await taskWorld();
    w.h.runtime.startError = new Error("not signed in");
    await w.h.cmd("tasks.create", { text: "fix api", start: true });
    await runs().idle();
    expect(live()).toMatchObject({ status: "error" });
    expect(await texts()).toContain("system: @acme-builder could not start: not signed in");
    w.h.runtime.startError = undefined;
    await send("please");
    await runs().idle();
    const prompts = w.h.runtime.sessions[0]?.prompts.map((p) => (p[0]?.type === "text" ? p[0].text : ""));
    // The brief that never went out goes first, then the message.
    expect(prompts).toEqual([expect.stringContaining("Read TASK.md"), "please"]);
  });

  it("stops every turn and closes sessions, then a new message starts the task again", async () => {
    const g = gated();
    const session = await started(g.script);
    await send("waiting");
    const res = await w.h.cmd("tasks.stop", { id: "ACM-1" });
    expect(res.body).toMatchObject({ status: "paused", pausedReason: "owner" });
    expect(session.closed).toBe(true);
    expect(live()).toMatchObject({ status: "stopped", queued: 1 });
    expect(runs().working("ACM-1")).toEqual([]);

    const again = await send("carry on");
    expect(again.status).toBe(200);
    await runs().idle();
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("running");
    expect(w.h.runtime.sessions).toHaveLength(2);
    expect(w.h.runtime.sessions[1]?.prompts.map((p) => (p[0]?.type === "text" ? p[0].text : ""))).toEqual([
      "waiting",
      "carry on",
    ]);
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
  it("says when model or effort is auto", async () => {
    w = await taskWorld({ agent: { model: "auto", effort: "auto" } });
    await w.h.cmd("tasks.create", { text: "fix api", start: true });
    await runs().idle();
    expect(w.h.runtime.starts[0]).not.toHaveProperty("model");
    expect(w.h.runtime.starts[0]).not.toHaveProperty("effort");
    const t = await texts();
    expect(t).toContain("system: @acme-builder started on claude-acme, model fake-model, effort medium");
    expect(t).toContain(
      "system: @acme-builder is set to auto for model or effort. This version uses the agent's own default.",
    );
  });

  it("refuses an account of another org", async () => {
    w = await taskWorld();
    await w.h.cmd("orgs.create", { id: "beta", name: "Beta" });
    await w.h.cmd("accounts.create", { id: "claude-beta", tool: "claude", org: "beta", auth: "login" });
    await w.h.cmd("agents.update", {
      id: "acme-builder",
      frontmatter: { scope: "acme", role: "Builder", account: "claude-beta", perms: ["edit"] },
      instructions: "",
    });
    await w.h.cmd("tasks.create", { text: "fix api", start: true });
    await runs().idle();
    expect(await texts()).toContain(
      'system: @acme-builder could not start: @acme-builder works in "acme" and cannot use the account of "beta".',
    );
    expect(w.h.runtime.starts).toHaveLength(0);
  });
});

describe("attachments in messages", () => {
  it("sends images as image blocks and names files by path", async () => {
    const session = await started();
    await runs().idle();
    const upload = async (name: string, type: string, data: Uint8Array) => {
      const form = new FormData();
      form.set("file", new File([data], name, { type }));
      return (await (await w.h.majhi.app.request("/api/uploads", { method: "POST", body: form })).json()) as {
        id: string;
      };
    };
    const image = await upload("shot.png", "image/png", new Uint8Array([1, 2, 3]));
    const file = await upload("data.csv", "text/csv", new TextEncoder().encode("a,b"));
    const res = await send("look at these", { attachments: [image.id, file.id] });
    expect(res.status).toBe(200);
    expect(res.body.item.attachments).toMatchObject([
      { kind: "image", name: "shot.png", path: "shot.png" },
      { kind: "file", name: "data.csv", path: "data.csv" },
    ]);
    await runs().idle();
    const blocks = session.prompts[1];
    expect(blocks?.[0]).toEqual({
      type: "text",
      text: `look at these\n\nAttached files:\n- ${join(w.taskDir("ACM-1"), "attachments", "data.csv")}`,
    });
    expect(blocks?.[1]).toEqual({
      type: "image",
      mime: "image/png",
      data: Buffer.from([1, 2, 3]).toString("base64"),
    });
    expect(
      (await w.h.cmd("tasks.get", { id: "ACM-1" })).body.attachments.map((a: { name: string }) => a.name),
    ).toEqual(["shot.png", "data.csv"]);
  });
});

describe("room history and files", () => {
  it("pages older items newest first", async () => {
    w = await taskWorld();
    await w.h.cmd("tasks.create", { text: "fix api", start: true });
    await runs().idle();
    const all = (await w.h.cmd("room.items", { task: "ACM-1", limit: 500 })).body;
    expect(all.more).toBe(false);
    expect(all.items.map((i: RoomItem) => i.seq)).toEqual(
      [...all.items.map((i: RoomItem) => i.seq)].sort((a, b) => b - a),
    );
    const first = (await w.h.cmd("room.items", { task: "ACM-1", limit: 2 })).body;
    expect(first.items).toHaveLength(2);
    expect(first.more).toBe(true);
    const rest = (await w.h.cmd("room.items", { task: "ACM-1", limit: 5, beforeSeq: first.items[1].seq }))
      .body;
    expect(rest.items.length + 2).toBe(all.items.length);
    expect(rest.more).toBe(false);
  });

  it("searches file names across the task's worktrees, relative to the task folder", async () => {
    w = await taskWorld();
    await w.h.cmd("tasks.create", { text: "fix api", start: true });
    await runs().idle();
    const wt = join(w.taskDir("ACM-1"), "acme-api");
    await mkdir(join(wt, "src", "routes"), { recursive: true });
    await writeFile(join(wt, "src", "routes", "health.ts"), "x");
    await writeFile(join(wt, "src", "index.ts"), "x");
    const hit = await w.h.cmd("room.files", { task: "ACM-1", query: "health" });
    expect(hit.body).toEqual([{ path: "acme-api/src/routes/health.ts", repo: "acme-api" }]);
    const all = await w.h.cmd("room.files", { task: "ACM-1", query: "" });
    expect(all.body.map((f: { path: string }) => f.path)).toEqual([
      "acme-api/README.md",
      "acme-api/src/index.ts",
      "acme-api/src/routes/health.ts",
    ]);
  });
});
