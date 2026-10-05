import type { Cadence } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { inQuiet, isDue, latestSlot, nextRun } from "./schedule.ts";

/** When a playbook is due: clock changes, DST, jumps of the clock, quiet hours. */

const NY = "America/New_York";
const at = (iso: string) => new Date(iso);

describe("every N minutes", () => {
  const hourly: Cadence = { kind: "every", minutes: 60 };

  it("does not fire twice when the clock is set back: a last run in the future counts as now", () => {
    const now = at("2026-10-04T10:00:00Z");
    const future = at("2026-10-04T15:00:00Z");
    expect(isDue(hourly, future, now, "UTC")).toBe(false);
    // The service rewrites a last run in the future to the moment it saw it, so the interval counts from there.
    expect(nextRun(hourly, future, now, "UTC")?.toISOString()).toBe("2026-10-04T11:00:00.000Z");
  });
});

describe("daily", () => {
  const daily: Cadence = { kind: "daily", at: "08:00" };

  it("makes one catch-up run after three days off, not three", () => {
    const last = at("2026-10-01T08:00:00Z");
    const now = at("2026-10-04T09:00:00Z");
    expect(isDue(daily, last, now, "UTC")).toBe(true);
    // Once it ran at `now`, it is not due again.
    expect(isDue(daily, now, at("2026-10-04T09:05:00Z"), "UTC")).toBe(false);
  });

  it("a clock set back an hour after the run does not run it again", () => {
    const ran = at("2026-10-04T08:30:00Z");
    expect(isDue(daily, ran, at("2026-10-04T07:30:00Z"), "UTC")).toBe(false);
    expect(isDue(daily, ran, at("2026-10-04T08:31:00Z"), "UTC")).toBe(false);
  });

  it("spring forward: a 02:30 slot that does not exist runs at 03:30, just after the change, once", () => {
    const slotDay: Cadence = { kind: "daily", at: "02:30" };
    // 2026-03-08, New York: 02:00 jumps to 03:00 (07:00 UTC).
    const before = at("2026-03-08T07:29:00Z");
    const after = at("2026-03-08T07:31:00Z");
    expect(isDue(slotDay, at("2026-03-07T07:31:00Z"), before, NY)).toBe(false);
    expect(isDue(slotDay, at("2026-03-07T07:31:00Z"), after, NY)).toBe(true);
    expect(latestSlot(slotDay, after, NY)?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(isDue(slotDay, after, at("2026-03-08T12:00:00Z"), NY)).toBe(false);
  });

  it("fall back: a 01:30 slot that happens twice runs once", () => {
    const slotDay: Cadence = { kind: "daily", at: "01:30" };
    // 2026-11-01, New York: 02:00 EDT falls back to 01:00 EST. 01:30 is 05:30Z (EDT) and 06:30Z (EST).
    const first = at("2026-11-01T05:31:00Z");
    expect(isDue(slotDay, at("2026-10-31T05:31:00Z"), first, NY)).toBe(true);
    expect(isDue(slotDay, first, at("2026-11-01T06:31:00Z"), NY)).toBe(false);
  });

  it("uses the workspace's day, not UTC's", () => {
    // 23:30 in New York on Oct 3 is 03:30Z on Oct 4: the Oct 3 slot, not Oct 4's.
    const slot = latestSlot({ kind: "daily", at: "08:00" }, at("2026-10-04T03:30:00Z"), NY);
    expect(slot?.toISOString()).toBe("2026-10-03T12:00:00.000Z");
  });
});

describe("quiet hours", () => {
  it("holds a window that wraps midnight, in the workspace's zone", () => {
    const quiet = { from: "22:00", to: "07:00" };
    expect(inQuiet(quiet, at("2026-10-04T03:00:00Z"), "UTC")).toBe(true);
    expect(inQuiet(quiet, at("2026-10-04T12:00:00Z"), "UTC")).toBe(false);
    // 02:00Z is 22:00 in New York (EDT): quiet there, not in UTC.
    expect(inQuiet(quiet, at("2026-10-04T02:00:00Z"), NY)).toBe(true);
    expect(inQuiet(quiet, at("2026-10-04T02:00:00Z"), "UTC")).toBe(true);
    expect(inQuiet(quiet, at("2026-10-04T14:00:00Z"), NY)).toBe(false);
  });
});
