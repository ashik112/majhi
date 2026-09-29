import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startSession } from "@majhi/acp";
import { type FakeAgentOptions, fakeAdapter } from "@majhi/acp/testing";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

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
  const res = await w.h.cmd("tasks.create", { text, start: true });
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
