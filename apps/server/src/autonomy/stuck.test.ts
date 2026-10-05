import { describe, expect, it } from "vitest";
import { stuckTasks } from "./stuck.ts";

const now = new Date("2026-10-04T12:00:00Z");
const task = (id: string, status: "running" | "review" | "paused", updatedAt: string) => ({
  id,
  title: `Task ${id}`,
  status,
  updatedAt,
});

describe("stuckTasks", () => {
  it("flags a running task quiet for two hours, not one quiet for one", () => {
    const out = stuckTasks({
      now,
      tasks: [task("T-1", "running", "2026-10-04T09:30:00Z"), task("T-2", "running", "2026-10-04T11:00:00Z")],
      waiting: [],
    });
    expect(out.map((s) => [s.task, s.kind])).toEqual([["T-1", "idle"]]);
  });

  it("flags a task left in review for four hours, not one left for three", () => {
    const out = stuckTasks({
      now,
      tasks: [task("T-1", "review", "2026-10-04T07:00:00Z"), task("T-2", "review", "2026-10-04T09:00:00Z")],
      waiting: [],
    });
    expect(out.map((s) => [s.task, s.kind])).toEqual([["T-1", "waiting"]]);
  });

  it("does not list a task that is held: paused, or with a card waiting for the owner", () => {
    const out = stuckTasks({
      now,
      tasks: [task("T-1", "paused", "2026-10-03T07:00:00Z"), task("T-2", "running", "2026-10-04T01:00:00Z")],
      waiting: [
        { task: "T-2", item: "i1", kind: "approval", text: "Push", why: "owner", at: "2026-10-04T02:00:00Z" },
      ],
    });
    expect(out).toEqual([]);
  });
});
