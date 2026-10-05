import type { RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { seedStatus } from "../../testing/status.ts";
import { taskWorld, type World } from "../../testing/world.ts";

/**
 * The moves the old code made that the lifecycle table refuses (docs/design/task-lifecycle.md 4.4),
 * pinned with what they do now. Each says what the old code did.
 */

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const world = (): World => {
  if (w === undefined) throw new Error("no world");
  return w;
};
const services = () => world().h.majhi.services;
const cmd = (name: string, body?: unknown) => world().h.cmd(name, body);
const get = async (id = "ACM-1"): Promise<Task> => (await cmd("tasks.get", { id })).body;
const notes = async (id = "ACM-1") =>
  ((await cmd("room.items", { task: id, limit: 300 })).body.items as RoomItem[]).flatMap((i) =>
    i.type === "system" ? [i.text] : [],
  );

async function created(): Promise<void> {
  w = await taskWorld();
  const res = await cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: false });
  expect(res.status).toBe(200);
}

const refusals = (id = "ACM-1") =>
  services()
    .store.lifecycle.events(id)
    .filter((e) => e.refused);

describe("a tell on a task with a merge request open", () => {
  // Old: tellAgent called start(), which wrote running over mr. Now the task stays mr and the room says why.
  it.each(["majhi", "captain"])("from %s posts a note and does not restart the task", async (by) => {
    await created();
    seedStatus(services().store, "ACM-1", "mr");
    await services().tasks.tellAgent({
      task: "ACM-1",
      agent: "acme-builder",
      text: "advice",
      settled: "told",
      by,
    });
    expect((await get()).status).toBe("mr");
    expect((await notes()).join("\n")).toContain("has a merge request open");
  });

  it("the scheduler's message does not restart it either", async () => {
    await created();
    seedStatus(services().store, "ACM-1", "mr");
    await services().tasks.postFromScheduler({ task: "ACM-1", text: "check in", from: "nightly" });
    expect((await get()).status).toBe("mr");
  });

  it("the owner's message sends it back to work: review comments to address", async () => {
    await created();
    seedStatus(services().store, "ACM-1", "mr");
    await services().tasks.start("ACM-1", "owner");
    expect((await get()).status).toBe("running");
    expect(
      services()
        .store.lifecycle.events("ACM-1")
        .map((e) => e.event),
    ).toContain("sendBack");
  });
});

describe("start on a task that waits for another", () => {
  // Old: checkStartable wrote ready and the wish, then threw 409. Same result now, as its own event.
  it("keeps the owner's wish as a wishStart event and still says it waits", async () => {
    await created();
    const second = await cmd("tasks.create", {
      text: "second",
      repos: [{ project: "acme-api" }],
      start: false,
      dependsOn: ["ACM-1"],
    });
    expect(second.status).toBe(200);
    const id = (second.body as Task).id;
    const res = await cmd("tasks.start", { id });
    expect(res.status).toBe(409);
    const t = await get(id);
    expect(t.status).toBe("ready");
    expect(services().store.tasks.startWhenReady(id)).toBe(true);
    expect(
      services()
        .store.lifecycle.events(id)
        .map((e) => e.event),
    ).toEqual(["wishStart"]);
  });
});

describe("a run reports into a task that cannot take it", () => {
  // Old: pausedByRuns returned without a trace for any other status. Now it is a recorded refusal.
  it("a pause for a done task is refused and logged, and the task stays done", async () => {
    await created();
    seedStatus(services().store, "ACM-1", "done");
    await services().tasks.pausedByRuns("ACM-1", "offline");
    expect((await get()).status).toBe("done");
    expect(refusals().map((e) => [e.event, e.code])).toEqual([["runPaused", "wrong-status"]]);
  });
});

describe("a schedule and an owner's stop", () => {
  // Old: postFromScheduler started a task the owner had stopped. A hold only its owner may lift stays.
  it("a scheduled message does not restart a task the owner stopped", async () => {
    await created();
    seedStatus(services().store, "ACM-1", "paused", "owner");
    await expect(
      services().tasks.postFromScheduler({ task: "ACM-1", text: "check in", from: "nightly" }),
    ).rejects.toThrow(/stopped it/i);
    expect((await get()).status).toBe("paused");
  });
});
