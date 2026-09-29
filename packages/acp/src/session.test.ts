import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAdapter } from "../testing/index.ts";
import type { AccountRuntime } from "./index.ts";
import {
  type AgentSession,
  type PermissionAsk,
  type SessionEvent,
  type SessionStart,
  startSession,
} from "./session.ts";

const base = { PATH: process.env.PATH ?? "/usr/bin" };
let root: string;
let open: AgentSession[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-session-"));
});
afterEach(async () => {
  await Promise.all(open.map((s) => s.close()));
  open = [];
  await rm(root, { recursive: true, force: true });
});

const account: AccountRuntime = { tool: "claude", home: "" };

async function start(
  fake: Parameters<typeof fakeAdapter>[1] = {},
  extra: Partial<SessionStart> = {},
): Promise<{ session: AgentSession; events: SessionEvent[]; cwd: string }> {
  const cwd = extra.cwd ?? join(root, "task");
  const session = await startSession({
    account: { ...account, home: join(root, "home") },
    options: { base, adapters: { claude: fakeAdapter("claude", { signedIn: true, ...fake }) } },
    cwd: await ensure(cwd),
    ...extra,
  });
  open.push(session);
  const events: SessionEvent[] = [];
  session.onEvent((e) => events.push(e));
  return { session, events, cwd };
}

async function ensure(dir: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  return dir;
}

const text = (t: string) => [{ type: "text" as const, text: t }];
const answer = (id: string | undefined) => async () => id;

function summarize(events: SessionEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const label =
      e.type === "tool" ? `tool:${e.toolCallId}:${e.status ?? "-"}` : e.type === "text" ? "text" : e.type;
    if (out[out.length - 1] !== label || e.type === "tool") out.push(label);
  }
  return out;
}

describe("default turn", () => {
  it("streams the full scripted sequence and writes the file", async () => {
    const { session, events, cwd } = await start();
    const asks: PermissionAsk[] = [];
    session.setPermissionHandler(async (ask) => {
      asks.push(ask);
      return "allow";
    });
    const res = await session.prompt(text("please create notes/HEALTH.md"));
    expect(res.stopReason).toBe("end_turn");
    expect(summarize(events)).toEqual([
      "commands",
      "plan",
      "usage",
      "text",
      "tool:t-read:pending",
      "tool:t-read:completed",
      "usage",
      "plan",
      "tool:t-edit:in_progress",
      "tool:t-edit:completed",
      "tool:t-exec:pending",
      "tool:t-exec:in_progress",
      "tool:t-exec:completed",
      "plan",
      "usage",
      "text",
    ]);
    expect(events[0]).toEqual({
      type: "commands",
      commands: [
        { name: "compact", description: "Compact the conversation" },
        { name: "review", description: "Review the current changes" },
      ],
    });
    const edit = events.find(
      (e) => e.type === "tool" && e.toolCallId === "t-edit" && e.status === "completed",
    );
    expect(edit).toEqual({
      type: "tool",
      toolCallId: "t-edit",
      status: "completed",
      content: [{ type: "diff", path: join(cwd, "notes/HEALTH.md"), newText: "# Health\n\nok\n" }],
    });
    expect(await readFile(join(cwd, "notes/HEALTH.md"), "utf8")).toBe("# Health\n\nok\n");
    expect(asks).toEqual([
      {
        toolCallId: "t-exec",
        title: "Run npm test",
        kind: "execute",
        command: "npm test",
        options: [
          { id: "allow", name: "Allow", kind: "allow_once" },
          { id: "allow_always", name: "Always allow", kind: "allow_always" },
          { id: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    ]);
    const texts = events.filter((e) => e.type === "text");
    expect(new Set(texts.slice(0, 2).map((t) => (t.type === "text" ? t.messageId : ""))).size).toBe(1);
    expect(
      texts[0]?.type === "text" && texts[2]?.type === "text" && texts[0].messageId !== texts[2].messageId,
    ).toBe(true);
  });

  it("cancels the permission when there is no handler or the handler gives up", async () => {
    const { session, events } = await start();
    await session.prompt(text("hello"));
    expect(events.filter((e) => e.type === "tool" && e.toolCallId === "t-exec").at(-1)).toMatchObject({
      status: "failed",
    });
    session.setPermissionHandler(answer(undefined));
    events.length = 0;
    await session.prompt(text("again"));
    expect(events.filter((e) => e.type === "tool" && e.toolCallId === "t-exec").at(-1)).toMatchObject({
      status: "failed",
    });
  });
});

describe("cancel and busy", () => {
  it("cancels mid-turn and aborts a pending permission", async () => {
    const { session } = await start({ slowMs: 100 });
    let signalled = false;
    session.setPermissionHandler(
      (_ask, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            signalled = true;
            resolve(undefined);
          });
        }),
    );
    const running = session.prompt(text("go"));
    await new Promise((r) => setTimeout(r, 250));
    const t0 = Date.now();
    await session.cancel();
    expect((await running).stopReason).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(signalled).toBe(false); // cancelled before the permission step
  });
});

describe("resume", () => {
  it("loads the session without emitting replayed messages", async () => {
    const first = await start();
    first.session.setPermissionHandler(answer("allow"));
    await first.session.prompt(text("hello there"));
    const id = first.session.sessionId;
    await first.session.close();

    const second = await start({}, { resume: id, cwd: first.cwd });
    expect(second.session.sessionId).toBe(id);
    // Only current state comes through: the commands list, no replayed text.
    expect(second.events.map((e) => e.type)).toEqual(["commands"]);
    await second.session.prompt(text("echo: again"));
    expect(second.events.filter((e) => e.type === "text")).toHaveLength(1);
  });

  it("starts a new session with a notice when the agent cannot load", async () => {
    const { session, events } = await start({ noLoadSession: true }, { resume: "fake-x" });
    expect(session.sessionId).not.toBe("fake-x");
    expect(events.find((e) => e.type === "notice")).toMatchObject({ level: "info" });
  });
});

describe("lifecycle", () => {
  it("emits exit and rejects the running prompt when the agent crashes", async () => {
    const { session, events } = await start();
    await expect(session.prompt(text("crash: now"))).rejects.toThrow(
      "Agent exited with code 3: fake-agent: crashed on purpose",
    );
    expect(events.at(-1)).toEqual({ type: "exit", code: 3, error: "fake-agent: crashed on purpose" });
    await expect(session.prompt(text("more"))).rejects.toThrow("closed");
  });

  it("close kills the process group", async () => {
    const { session } = await start({ slowMs: 100 });
    const running = session.prompt(text("go"));
    running.catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    const pid = pidOf(session);
    expect(() => process.kill(pid, 0)).not.toThrow();
    await session.close();
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(running).rejects.toThrow();
  });
});

function pidOf(session: AgentSession): number {
  if (session.pid === undefined) throw new Error("no pid");
  return session.pid;
}
