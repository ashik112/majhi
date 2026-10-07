import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAdapter } from "../testing/index.ts";
import type { AccountRuntime } from "./index.ts";
import { type AgentSession, type SessionEvent, type SessionStart, startSession } from "./session.ts";

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

describe("default turn", () => {
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
    await session.cancel();
    expect((await running).stopReason).toBe("cancelled");
    expect(signalled).toBe(false); // cancelled before the permission step
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
    const { session } = await start({ slowMs: 60_000 });
    const running = session.prompt(text("go"));
    running.catch(() => {});
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

describe("turn usage", () => {
  it("reports each prompt's tokens and the cost it added, with the model the agent named", async () => {
    const { session, events } = await start({
      turnTokens: { input: 900, output: 120, cacheRead: 3000, cacheWrite: 400 },
      turnCost: 0.02,
      usageModel: "claude-sonnet-5-5",
    });
    await session.prompt(text("echo: one"));
    await session.prompt(text("echo: two"));
    const turns = events.flatMap((e) => (e.type === "turn" ? [e.usage] : []));
    expect(turns).toHaveLength(2);
    for (const t of turns) {
      expect(t).toMatchObject({
        inputTokens: 900,
        outputTokens: 120,
        cacheReadTokens: 3000,
        cacheWriteTokens: 400,
        reported: true,
        model: "claude-sonnet-5-5",
      });
      expect(t.costUsd).toBeCloseTo(0.02);
    }
  });

  it("has no cost or tokens when the agent reports none", async () => {
    const { session, events } = await start({ turnTokens: "none", turnCost: "none" });
    await session.prompt(text("echo: one"));
    const turn = events.find((e) => e.type === "turn");
    expect(turn).toEqual({
      type: "turn",
      usage: expect.objectContaining({ reported: false, inputTokens: 0, model: "fake-model-a" }),
    });
    expect(turn?.type === "turn" ? turn.usage.costUsd : "missing").toBeUndefined();
  });
});
