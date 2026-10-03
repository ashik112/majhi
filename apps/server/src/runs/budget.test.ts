import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startSession } from "@majhi/acp";
import { type FakeAgentOptions, fakeAdapter } from "@majhi/acp/testing";
import type { AgentReceipt, RoomItem, TaskReceipt } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";
import type { AgentRun } from "./run.ts";

/**
 * The context budget (SPEC 5.13) end to end: the real ACP engine against the fake adapter,
 * which reports rising usage and answers `/compact` and the handoff request.
 */

let w: World;
afterEach(() => w?.cleanup());

async function world(options: FakeAgentOptions = {}): Promise<World> {
  w = await taskWorld();
  w.h.env.runtime.adapters = { claude: fakeAdapter("claude", { signedIn: true, ...options }) };
  w.h.runtime.startSession = (start) => {
    w.h.runtime.starts.push(start);
    return startSession(start);
  };
  return w;
}

/** The prompts a session of the fake received, as it stored them in the task folder. */
async function _received(sessionId: string | undefined, task = "ACM-1"): Promise<string[]> {
  const file = join(w.taskDir(task), ".fake-sessions", `${sessionId}.json`);
  const stored = JSON.parse(await readFile(file, "utf8")) as { messages: { role: string; text: string }[] };
  return stored.messages.filter((m) => m.role === "user").map((m) => m.text);
}

const runs = () => w.h.majhi.services.runs;
const live = (agent = "acme-builder", task = "ACM-1") => w.h.majhi.services.room.getLive(task, agent);

async function items(task = "ACM-1"): Promise<RoomItem[]> {
  const page = await w.h.cmd("room.items", { task, limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
}
const contexts = async (task = "ACM-1") =>
  (await items(task)).filter((i): i is Extract<RoomItem, { type: "context" }> => i.type === "context");
const _systems = async () => (await items()).flatMap((i) => (i.type === "system" ? [i.text] : []));

async function start(text = "fix api"): Promise<void> {
  const res = await w.h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await runs().idle();
}

async function send(text: string, task = "ACM-1"): Promise<void> {
  const res = await w.h.cmd("room.send", { task, text });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await runs().idle();
}

describe("compaction with the fake adapter", () => {
  it("compacts natively when the agent passes 80%, and says so in the room", async () => {
    await world({ risingUsage: 170_000 });
    await start();
    const [event] = await contexts();
    expect(event).toMatchObject({ agent: "acme-builder", method: "native", before: 170_000, after: 17_000 });
    expect(event?.note).toBeUndefined();
    expect(live()?.usage).toEqual({ used: 17_000, size: 200_000 });
    // The same session goes on: no new process, nothing re-read.
    await send("echo: still here");
    expect(w.h.majhi.services.store.runs.forTask("ACM-1")).toHaveLength(1);
  });
});

/** The agent's run, to read what the manager keeps private. */
function agentRun(agent = "acme-builder", task = "ACM-1"): AgentRun | undefined {
  const all = (runs() as unknown as { runs: Map<string, AgentRun> }).runs;
  return [...all.values()].find((r) => r.task === task && r.agent === agent);
}

async function receipts(): Promise<{ task: TaskReceipt; agent: AgentReceipt }> {
  const task = await w.h.cmd("usage.receipt", { task: "ACM-1" });
  expect(task.status, JSON.stringify(task.body)).toBe(200);
  const agent = await w.h.cmd("usage.agentReceipt", { agent: "acme-builder" });
  expect(agent.status, JSON.stringify(agent.body)).toBe(200);
  return { task: task.body as TaskReceipt, agent: agent.body as AgentReceipt };
}

describe("compactions the CLI does on its own inside a turn (PRV-103)", () => {
  /** The one compaction, sized `before` to `after`. */
  async function expectRecorded(before: number, after: number): Promise<void> {
    const events = await contexts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agent: "acme-builder", method: "auto", before, after });
    // The report is the context line, not a tool row.
    const rows = (await items()).filter((i) => i.type === "tool" && i.title === "Compact conversation");
    expect(rows).toEqual([]);
    const { task, agent } = await receipts();
    expect(task.compactions).toEqual([
      expect.objectContaining({
        agent: "acme-builder",
        method: "native",
        reason: "auto",
        before,
        after,
      }),
    ]);
    expect(agent.compactions).toBe(1);
    expect(agent.nativeCompactions).toBe(1);
    // majhi's per-turn cap counts only its own compactions, and the session goes on.
    expect(agentRun()?.compactions).toBe(0);
    expect(live()?.usage).toEqual({ used: 40_000, size: 200_000 });
    expect(w.h.majhi.services.store.runs.forTask("ACM-1")).toHaveLength(1);
  }

  it("records Claude's compaction report with its tokens and says so in the room", async () => {
    await world();
    await start();
    await send("self-compact: go on");
    // The tokens Claude counted, not the readings around them: the report, not the drop.
    await expectRecorded(162_000, 38_000);
  });

  it("records Codex's compaction report, sized by the next usage reading", async () => {
    await world();
    w.h.env.runtime.adapters = { claude: fakeAdapter("codex", { signedIn: true }) };
    await start();
    await send("self-compact: go on");
    await expectRecorded(160_000, 40_000);
  });

  it("spots a compaction nothing reported from the drop in usage", async () => {
    await world();
    await start();
    await send("usage-drop: go on");
    await expectRecorded(160_000, 40_000);
  });

  it("does not take majhi's own compaction for the CLI's", async () => {
    await world({ risingUsage: 170_000 });
    await start();
    expect((await contexts()).map((c) => c.method)).toEqual(["native"]);
  });
});
