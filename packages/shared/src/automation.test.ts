import { describe, expect, it } from "vitest";
import { parseSchedulePhrase, resolveSpec, type ScheduleSpec } from "./automation.ts";
import { nextRunAfter, onceInstant, upcomingRuns } from "./schedule-time.ts";

const iso = (d: Date | undefined) => d?.toISOString();

describe("parseSchedulePhrase", () => {
  const cases: [string, ScheduleSpec][] = [
    ["every 1 hour", { kind: "interval", every: 1, unit: "hours" }],
    ["Every 30 minutes", { kind: "interval", every: 30, unit: "minutes" }],
    ["every hour", { kind: "interval", every: 1, unit: "hours" }],
    ["every 2 days", { kind: "interval", every: 2, unit: "days" }],
    ["hourly", { kind: "interval", every: 1, unit: "hours" }],
    ["daily at 18:30", { kind: "cron", expression: "30 18 * * *" }],
    ["every day at 6pm", { kind: "cron", expression: "0 18 * * *" }],
    ["weekdays at 9:00", { kind: "cron", expression: "0 9 * * 1-5" }],
    ["mondays at 9:00", { kind: "cron", expression: "0 9 * * 1" }],
    ["every monday at 09:15", { kind: "cron", expression: "15 9 * * 1" }],
    ["mon and fri at 7:05am", { kind: "cron", expression: "5 7 * * 1,5" }],
    ["weekends at 12am", { kind: "cron", expression: "0 0 * * 0,6" }],
    ["*/15 * * * *", { kind: "cron", expression: "*/15 * * * *" }],
  ];
  it.each(cases)("reads %s", (phrase, spec) => {
    expect(parseSchedulePhrase(phrase)).toEqual({ ok: true, spec });
  });

  const bad: [string, RegExp][] = [
    ["", /Say when/],
    ["banana", /could not read/],
    ["daily", /Add a time/],
    ["weekdays at 25:00", /not a time/],
    ["daily at 9:75", /not a time/],
    ["daily at 13pm", /not a time/],
    ["every 0 minutes", /at least 1/],
    ["every 5 fortnights", /could not read/],
    ["funday at 9:00", /not a day/],
    ["61 * * * *", /Not a valid cron/],
  ];
  it.each(bad)("rejects %j with a clear error", (phrase, message) => {
    const result = parseSchedulePhrase(phrase);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});

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

  it("gives the same expression different instants in different zones", () => {
    const spec: ScheduleSpec = { kind: "cron", expression: "0 9 * * 1-5" };
    const from = new Date("2026-10-02T10:00:00Z"); // a Friday
    expect(iso(nextRunAfter(spec, "UTC", from))).toBe("2026-10-05T09:00:00.000Z");
    expect(iso(nextRunAfter(spec, "Asia/Tokyo", from))).toBe("2026-10-05T00:00:00.000Z");
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
  it("takes a time with an offset as it is", () => {
    expect(iso(onceInstant("2026-10-02T09:00:00+02:00", "UTC"))).toBe("2026-10-02T07:00:00.000Z");
  });

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
