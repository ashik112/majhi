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

  it("defaults the file to HEALTH.md and reports denied permission as a failed tool", async () => {
    const { session, events, cwd } = await start();
    session.setPermissionHandler(answer("reject"));
    await session.prompt(text("hello"));
    const exec = events.filter((e) => e.type === "tool" && e.toolCallId === "t-exec");
    expect(exec.at(-1)).toMatchObject({ status: "failed" });
    expect(await readFile(join(cwd, "HEALTH.md"), "utf8")).toContain("Health");
    expect(events.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("could not run the tests"),
    });
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

  it("echoes prompts that start with echo:", async () => {
    const { session, events } = await start();
    await session.prompt(text("echo: hi"));
    expect(events.filter((e) => e.type === "text")).toEqual([
      { type: "text", messageId: expect.any(String), text: "echo: echo: hi" },
    ]);
  });
});

describe("show: media", () => {
  it("writes a chart and a page, links them in markdown, and sends an image block and a link", async () => {
    const { session, events, cwd } = await start();
    await session.prompt(text("show: media"));
    const png = await readFile(join(cwd, "media", "chart.png"));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(await readFile(join(cwd, "media", "report.html"), "utf8")).toContain("/api/cmd/tasks.list");
    expect(events.filter((e) => e.type === "text")).toEqual([
      {
        type: "text",
        messageId: expect.any(String),
        text: expect.stringContaining("![Latency chart](media/chart.png)"),
      },
    ]);
    expect(events.filter((e) => e.type === "media")).toEqual([
      {
        type: "media",
        messageId: expect.any(String),
        block: { kind: "image", mime: "image/png", data: png.toString("base64") },
      },
      {
        type: "media",
        messageId: expect.any(String),
        block: { kind: "link", uri: "https://example.com/spec", name: "Spec sheet" },
      },
    ]);
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

  it("aborts the signal of a pending permission ask", async () => {
    const { session } = await start({ slowMs: 20 });
    let asked!: () => void;
    const gotAsk = new Promise<void>((r) => {
      asked = r;
    });
    let signalled = false;
    session.setPermissionHandler(
      (_ask, signal) =>
        new Promise((resolve) => {
          asked();
          signal.addEventListener("abort", () => {
            signalled = true;
            resolve(undefined);
          });
        }),
    );
    const running = session.prompt(text("go"));
    await gotAsk;
    await session.cancel();
    expect((await running).stopReason).toBe("cancelled");
    expect(signalled).toBe(true);
  });

  it("refuses a second prompt while one runs", async () => {
    const { session } = await start({ slowMs: 100 });
    const running = session.prompt(text("one"));
    await expect(session.prompt(text("two"))).rejects.toThrow("already running");
    await session.cancel();
    await running;
    expect((await session.prompt(text("echo: three"))).stopReason).toBe("end_turn");
  });
});

describe("options", () => {
  it("applies model and effort and reports them", async () => {
    const { session, events } = await start(
      { models: ["m1", "m2"], efforts: ["low", "high"] },
      { model: "m2", effort: "high" },
    );
    expect(session.models).toMatchObject({ defaultModel: "m2", defaultEffort: "high" });
    expect(events.filter((e) => e.type === "config").at(-1)).toEqual({
      type: "config",
      model: "m2",
      effort: "high",
    });
    await session.setOption("model", "m1");
    expect(session.models.defaultModel).toBe("m1");
    await expect(session.setOption("model", "nope")).rejects.toThrow("Unknown model");
  });

  it("warns and keeps the default for an unknown model", async () => {
    const { session, events } = await start({ models: ["m1", "m2"] }, { model: "gpt-9" });
    expect(session.models.defaultModel).toBe("m1");
    expect(events.filter((e) => e.type === "notice")).toEqual([
      { type: "notice", level: "warn", text: "Unknown model: gpt-9. Keeping the default model (m1)." },
    ]);
  });
});

describe("images", () => {
  it("sends images when advertised and says how many arrived", async () => {
    const { session, events } = await start();
    session.setPermissionHandler(answer("allow"));
    await session.prompt([...text("look"), { type: "image", mime: "image/png", data: "AAAA" }]);
    expect(events.some((e) => e.type === "text" && e.text.includes("Got 1 image(s)."))).toBe(true);
  });

  it("turns images into a text note when the agent cannot read them", async () => {
    const { session, events } = await start({ noImages: true });
    session.setPermissionHandler(answer("allow"));
    await session.prompt([...text("look"), { type: "image", mime: "image/png", data: "AAAA" }]);
    expect(events.some((e) => e.type === "text" && e.text.includes("Got"))).toBe(false);
  });

  it("passes resource links", async () => {
    const { session } = await start();
    const r = await session.prompt([
      ...text("echo: see"),
      { type: "resource_link", uri: "file:///a.md", name: "a.md", mime: "text/markdown" },
    ]);
    expect(r.stopReason).toBe("end_turn");
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

  it("starts a new session with a notice when the old one is gone", async () => {
    const { session, events } = await start({}, { resume: "fake-missing" });
    expect(session.sessionId).not.toBe("fake-missing");
    expect(events.find((e) => e.type === "notice")).toMatchObject({ level: "warn" });
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

  it("unsubscribes listeners", async () => {
    const { session } = await start();
    const seen: string[] = [];
    const off = session.onEvent((e) => seen.push(e.type));
    off();
    await session.prompt(text("echo: x"));
    expect(seen).toEqual([]);
  });

  it("fails clearly when the command does not exist", async () => {
    await expect(
      startSession({
        account: { ...account, home: join(root, "home") },
        options: { base, adapters: { claude: { command: "/nonexistent/adapter", args: [] } } },
        cwd: await ensure(join(root, "t")),
      }),
    ).rejects.toThrow("Command not found");
  });
});

function pidOf(session: AgentSession): number {
  if (session.pid === undefined) throw new Error("no pid");
  return session.pid;
}
