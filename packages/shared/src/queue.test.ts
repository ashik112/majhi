import { describe, expect, it } from "vitest";
import type { OwnerDecision } from "./inbox.ts";
import { buildQueue } from "./queue.ts";

function decision(over: Partial<OwnerDecision> & Pick<OwnerDecision, "id" | "kind">): OwnerDecision {
  return {
    title: over.id,
    options: [],
    at: "2026-10-19T10:00:00.000Z",
    link: { kind: "limits" },
    ...over,
  };
}

describe("the Needs you queue", () => {
  it("merges tasks held by the same blocker and sign-ins into one row with their count", () => {
    const blockedBy: Record<string, string[]> = {
      "ACM-1": ["ACM-9", "ACM-8"],
      "ACM-2": ["ACM-8", "ACM-9"],
      "ACM-3": ["ACM-8", "ACM-9"],
      "ACM-4": ["ACM-7"],
    };
    const rows = buildQueue(
      [
        decision({ id: "room:ACM-1:p", kind: "paused", task: "ACM-1", at: "2026-10-19T09:00:00.000Z" }),
        decision({ id: "room:ACM-2:p", kind: "paused", task: "ACM-2", at: "2026-10-19T09:05:00.000Z" }),
        decision({ id: "room:ACM-3:p", kind: "paused", task: "ACM-3", at: "2026-10-19T09:10:00.000Z" }),
        decision({ id: "room:ACM-4:p", kind: "paused", task: "ACM-4" }),
        decision({ id: "signin:a", kind: "sign-in" }),
        decision({ id: "signin:b", kind: "sign-in" }),
        decision({ id: "incident:1", kind: "incident" }),
        decision({ id: "room:ACM-5:ship", kind: "ship", task: "ACM-5" }),
      ],
      (task) => blockedBy[task] ?? [],
    );

    expect(rows.incident.map((r) => [r.id, r.decisions.length])).toEqual([["incident:1", 1]]);
    expect(rows.review.map((r) => [r.id, r.decisions.length])).toEqual([["room:ACM-5:ship", 1]]);
    // The three tasks with the same blockers are one row, oldest first; the fourth waits on another task.
    expect(rows.decide.map((r) => [r.decisions.length, r.at])).toEqual([
      [3, "2026-10-19T09:00:00.000Z"],
      [1, "2026-10-19T10:00:00.000Z"],
      [2, "2026-10-19T10:00:00.000Z"],
    ]);
    expect(rows.decide[0]?.decisions.map((d) => d.id)).toEqual(["room:ACM-1:p", "room:ACM-2:p", "room:ACM-3:p"]);
  });
});
