import type { RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

/** Starting a task the owner was needed on (paused `blocked`) must run its agent. */

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});
const world = (): World => {
  if (w === undefined) throw new Error("no world");
  return w;
};
const cmd = (name: string, body?: unknown) => world().h.cmd(name, body);
const get = async (): Promise<Task> => (await cmd("tasks.get", { id: "ACM-1" })).body;
const items = async () => (await cmd("room.items", { task: "ACM-1", limit: 300 })).body.items as RoomItem[];
async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

let prompts: string[] = [];
async function blockedTask(): Promise<void> {
  prompts = [];
  w = await taskWorld();
  w.h.runtime.onSession = (session) => {
    session.script = async (t) => {
      prompts.push(t.text);
      t.emit({ type: "text", messageId: `m-${Math.random()}`, text: "Done." });
      return "end_turn";
    };
  };
  expect(
    (await cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true })).status,
  ).toBe(200);
  await world().h.majhi.services.runs.idle();
  await until(async () => (await get()).status === "review", "review");
  await world().h.majhi.services.tasks.pauseForOwner("ACM-1", "Nobody is left to wake.", "blocked");
  expect((await get()).status).toBe("paused");
}

describe("starting a blocked task", () => {
  it("a start that queues nothing leaves a typed hold and a room line, not a silent running", async () => {
    await blockedTask();
    // Nothing to run: the agent's turn never comes.
    world().h.majhi.services.runs.startTask = () => undefined;
    expect((await cmd("tasks.start", { id: "ACM-1" })).status).toBe(200);
    expect((await get()).status).toBe("paused");
    const last = world().h.majhi.services.store.lifecycle.events("ACM-1")[0];
    expect(last?.event).toBe("holdPlaced");
    const lines = (await items()).flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(lines.some((l) => l.startsWith("ACM-1 did not start"))).toBe(true);
  });
});
