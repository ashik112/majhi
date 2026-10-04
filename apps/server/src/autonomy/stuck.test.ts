import type { AutonomyEvent } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { stuckTasks } from "./stuck.ts";

const now = new Date("2026-10-04T12:00:00Z");
const task = (id: string, status: "running" | "review", updatedAt: string) => ({
  id,
  title: `Task ${id}`,
  status,
  updatedAt,
});
const ev = (seq: number, at: string, taskId: string, text: string, outcome?: AutonomyEvent["outcome"]) =>
  ({
    seq,
    at,
    kind: "decision",
    text,
    task: taskId,
    ...(outcome === undefined ? {} : { outcome }),
  }) as AutonomyEvent;

describe("stuckTasks", () => {
  it("flags a running task quiet for two hours, not one quiet for one", () => {
    const out = stuckTasks({
      now,
      tasks: [task("T-1", "running", "2026-10-04T09:30:00Z"), task("T-2", "running", "2026-10-04T11:00:00Z")],
      events: [],
      waiting: [],
    });
    expect(out.map((s) => [s.task, s.kind])).toEqual([["T-1", "idle"]]);
  });

  it("flags three failed calls, and four identical lines as a loop, once per task", () => {
    const failures = [1, 2, 3].map((i) => ev(i, `2026-10-04T1${i - 1}:00:00Z`, "T-1", `try ${i}`, "failed"));
    const repeats = [1, 2, 3, 4].map((i) => ev(10 + i, `2026-10-04T0${i}:00:00Z`, "T-2", "Woke the agent"));
    const out = stuckTasks({
      now,
      tasks: [task("T-1", "running", "2026-10-04T11:59:00Z"), task("T-2", "running", "2026-10-04T11:59:00Z")],
      events: [...failures, ...repeats],
      waiting: [],
    });
    expect(out.map((s) => [s.task, s.kind])).toEqual([
      ["T-2", "loop"],
      ["T-1", "failures"],
    ]);
  });

  it("flags a card waiting four hours and a task left in review", () => {
    const out = stuckTasks({
      now,
      tasks: [task("T-1", "running", "2026-10-04T11:59:00Z"), task("T-2", "review", "2026-10-04T05:00:00Z")],
      events: [],
      waiting: [
        { task: "T-1", item: "i1", kind: "approval", text: "Push", why: "owner", at: "2026-10-04T06:00:00Z" },
        { task: "T-1", item: "i2", kind: "approval", text: "New", why: "owner", at: "2026-10-04T11:00:00Z" },
      ],
    });
    expect(out.map((s) => [s.task, s.kind, s.item])).toEqual([
      ["T-2", "waiting", undefined],
      ["T-1", "waiting", "i1"],
    ]);
  });
});
