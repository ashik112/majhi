import { describe, expect, it } from "vitest";
import { resolveSpec, type ScheduleSpec } from "./automation.ts";
import { nextRunAfter, onceInstant, upcomingRuns } from "./schedule-time.ts";

const iso = (d: Date | undefined) => d?.toISOString();

describe("nextRunAfter", () => {
  it("counts an interval from the given time", () => {
    const spec: ScheduleSpec = { kind: "interval", every: 90, unit: "minutes" };
    expect(iso(nextRunAfter(spec, "UTC", new Date("2026-10-01T10:00:00Z")))).toBe("2026-10-01T11:30:00.000Z");
  });

  it("reads cron in the schedule's zone and follows a clock change", () => {
    const spec: ScheduleSpec = { kind: "cron", expression: "0 9 * * *" };
    // New York moves to summer time on 2026-03-08: 09:00 is 14:00 UTC before, 13:00 UTC after.
    const runs = upcomingRuns(spec, "America/New_York", new Date("2026-03-07T00:00:00Z"), 3);
    expect(runs.map(iso)).toEqual([
      "2026-03-07T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
    ]);
  });

  it("runs a once spec when its time is ahead, and never when it has passed", () => {
    const spec: ScheduleSpec = { kind: "once", at: "2026-10-02T09:00" };
    expect(iso(nextRunAfter(spec, "Europe/Berlin", new Date("2026-10-01T00:00:00Z")))).toBe(
      "2026-10-02T07:00:00.000Z",
    );
    expect(nextRunAfter(spec, "Europe/Berlin", new Date("2026-10-02T07:00:00Z"))).toBeUndefined();
  });
});

describe("onceInstant", () => {
  it("reads the hour a clock change skips as just after the change", () => {
    expect(iso(onceInstant("2026-03-29T02:30", "Europe/Berlin"))).toBe("2026-03-29T01:30:00.000Z");
  });

  it("reads the hour that happens twice as its first time", () => {
    expect(iso(onceInstant("2026-10-25T02:30", "Europe/Berlin"))).toBe("2026-10-25T00:30:00.000Z");
  });

  it("refuses what is not a time", () => {
    expect(onceInstant("tomorrow", "UTC")).toBeUndefined();
    expect(onceInstant("2026-02-31T09:00", "UTC")).toBeUndefined();
    expect(resolveSpec({ spec: { kind: "once", at: "soon" } }, "UTC").ok).toBe(false);
  });
});
