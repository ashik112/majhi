import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "../testing/harness.ts";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";

/** How background processes hold a task in running and wake its agent (5.15), with in-memory sessions. */

let w: World;
let extra: Harness | undefined;
afterEach(async () => {
  if (extra !== undefined) {
    await extra.majhi.services.runs.closeAll();
    await extra.majhi.close();
    extra = undefined;
  }
  await w?.cleanup();
});

const status = async (h: Harness) =>
  ((await h.cmd("tasks.get", { id: "ACM-1" })).body as { status: string }).status;
const systems = async (h: Harness) => {
  h.majhi.services.room.flush("ACM-1");
  const page = await h.cmd("room.items", { task: "ACM-1", limit: 500 });
  return (page.body.items as RoomItem[]).flatMap((i) => (i.type === "system" ? [i.text] : []));
};
/** ACM-1 whose first turn starts `command` in the background, as the agent's tool call would. */
async function startWith(command: string, wait: boolean): Promise<World> {
  w = await taskWorld();
  const { h } = w;
  h.runtime.onSession = (session) => {
    const first = session.script;
    let turns = 0;
    session.script = async (turn) => {
      turns++;
      if (turns === 1) {
        await h.majhi.services.processes.start({ task: "ACM-1", agent: "acme-builder", command, wait });
      }
      return first(turn);
    };
  };
  expect(
    (await h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true })).status,
  ).toBe(200);
  await until(() => h.runtime.sessions[0]?.prompts.length === 1, "the first turn");
  await h.majhi.services.runs.idle();
  return w;
}

describe("background processes and the task", () => {
  it("a running wait process keeps the task running until the owner stops it", async () => {
    const { h } = await startWith("sleep 30", true);
    expect(await status(h)).toBe("running");
    await until(async () => (await systems(h)).includes("Waiting for p1 `sleep 30`."), "the waiting note");

    const res = await h.cmd("processes.stop", { task: "ACM-1", id: "p1" });
    expect(res.status).toBe(200);
    expect(res.body.process).toMatchObject({ status: "stopped", stoppedBy: "owner" });
    await until(async () => (await status(h)) === "review", "review");
    // Nobody was woken.
    expect(h.runtime.sessions[0]?.prompts).toHaveLength(1);
  });

  it("stopping a task that waits on a process pauses it without passing through review", async () => {
    const { h } = await startWith("sleep 30", true);
    expect(await status(h)).toBe("running");
    expect((await h.cmd("tasks.stop", { id: "ACM-1" })).status).toBe(200);
    // Anything still in flight from the process's end.
    await new Promise((r) => setTimeout(r, 50));
    const trail = h.majhi.services.store.lifecycle.events("ACM-1").reverse();
    expect(trail.map((e) => e.event)).toEqual(["start", "ownerStop"]);
    expect(trail.every((e) => e.toStatus !== "review")).toBe(true);
    const task = (await h.cmd("tasks.get", { id: "ACM-1" })).body as {
      status: string;
      pausedReason?: string;
    };
    expect(task).toMatchObject({ status: "paused", pausedReason: "owner" });
    const items = (await h.cmd("room.items", { task: "ACM-1" })).body.items as { type: string }[];
    expect(items.some((i) => i.type === "review")).toBe(false);
  });
});
