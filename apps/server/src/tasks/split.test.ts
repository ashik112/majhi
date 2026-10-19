import type { RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("splitting a task", () => {
  it("writes the steps into the task's plan and makes no task", async () => {
    w = await taskWorld();
    const made = await w.h.cmd("tasks.create", {
      text: "Rework the export",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(made.status).toBe(200);
    const id = (made.body as Task).id;
    const before = ((await w.h.cmd("tasks.list", {})).body as Task[]).length;

    const split = await w.h.cmd("tasks.split", {
      task: id,
      steps: [
        { what: "Read the export code" },
        { who: "me", what: "Write the new endpoint" },
        { what: "Test it" },
      ],
      why: "One change, three steps.",
    });
    expect(split.status).toBe(200);
    expect(split.body).toEqual({ task: id, steps: 3 });

    // No task was made, and the plan is in the room with the steps in order.
    expect(((await w.h.cmd("tasks.list", {})).body as Task[]).length).toBe(before);
    const items = (await w.h.cmd("room.items", { task: id, limit: 50 })).body.items as RoomItem[];
    const plan = items.find((i) => i.type === "team-plan");
    expect(plan).toMatchObject({
      type: "team-plan",
      version: 1,
      why: "One change, three steps.",
      steps: [
        { who: "me", what: "Read the export code" },
        { who: "me", what: "Write the new endpoint" },
        { who: "me", what: "Test it" },
      ],
    });
  });
});
