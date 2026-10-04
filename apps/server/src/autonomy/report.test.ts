import type { AutonomyEvent } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { finishedByDay, hourlySpend } from "./report.ts";

const ev = (seq: number, at: string, task: string, status: string, org?: string): AutonomyEvent =>
  ({
    seq,
    at,
    kind: "task",
    text: "x",
    task,
    status,
    ...(org === undefined ? {} : { org }),
  }) as AutonomyEvent;

describe("hourlySpend", () => {
  it("buckets turns by hour from the day start up to the current hour", () => {
    const hours = hourlySpend(
      [
        { at: "2026-10-04T00:10:00Z", cost: 0.5, tokens: 100 },
        { at: "2026-10-04T00:50:00Z", cost: 0.25, tokens: 50 },
        { at: "2026-10-04T02:05:00Z", cost: 1, tokens: 10 },
      ],
      "2026-10-04T00:00:00.000Z",
      new Date("2026-10-04T02:30:00Z"),
    );
    expect(hours.map((h) => [h.start, h.cost, h.tokens])).toEqual([
      ["2026-10-04T00:00:00.000Z", 0.75, 150],
      ["2026-10-04T01:00:00.000Z", 0, 0],
      ["2026-10-04T02:00:00.000Z", 1, 10],
    ]);
  });
});

describe("finishedByDay", () => {
  it("counts a task once a day, by workspace, in the owner's zone, and fills empty days", () => {
    const days = finishedByDay(
      [
        ev(1, "2026-10-03T23:30:00Z", "ACM-1", "review", "acme"),
        ev(2, "2026-10-04T05:00:00Z", "ACM-1", "done", "acme"),
        ev(3, "2026-10-04T05:10:00Z", "ACM-2", "mr", "acme"),
        ev(4, "2026-10-04T06:00:00Z", "PRV-1", "done"),
        ev(5, "2026-10-04T06:00:00Z", "ACM-3", "running", "acme"),
      ],
      "2026-10-04",
      3,
      "Europe/Berlin",
    );
    expect(days).toEqual([
      { day: "2026-10-02", orgs: [] },
      { day: "2026-10-03", orgs: [] },
      {
        day: "2026-10-04",
        orgs: [
          { org: "acme", count: 2 },
          { org: "private", count: 1 },
        ],
      },
    ]);
  });
});
