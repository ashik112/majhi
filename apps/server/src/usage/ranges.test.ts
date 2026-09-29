import { describe, expect, it } from "vitest";
import { addDays, dayBounds, dayStart, localDay, monthStart, rangeDays, weekStart } from "./ranges.ts";

describe("local days", () => {
  it("reads the day an instant falls on in the zone", () => {
    const at = "2026-09-28T23:30:00.000Z";
    expect(localDay(at, "UTC")).toBe("2026-09-28");
    expect(localDay(at, "Asia/Dhaka")).toBe("2026-09-29");
    expect(localDay(at, "America/Los_Angeles")).toBe("2026-09-28");
  });

  it("finds local midnight, also on the days clocks change", () => {
    expect(dayStart("2026-09-29", "Asia/Dhaka").toISOString()).toBe("2026-09-28T18:00:00.000Z");
    expect(dayStart("2026-03-08", "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(dayStart("2026-03-09", "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z");
    // The day the clocks go forward is 23 hours long.
    const { start, end } = dayBounds("2026-03-08", "2026-03-08", "America/New_York");
    expect(Date.parse(end) - Date.parse(start)).toBe(23 * 3_600_000);
  });

  it("starts weeks on Monday and months on the 1st", () => {
    expect(weekStart("2026-09-29")).toBe("2026-09-28"); // a Tuesday
    expect(weekStart("2026-09-28")).toBe("2026-09-28");
    expect(weekStart("2026-10-04")).toBe("2026-09-28"); // a Sunday
    expect(monthStart("2026-09-29")).toBe("2026-09-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("names the days of each range", () => {
    const today = "2026-09-29";
    expect(rangeDays("today", today)).toEqual({ from: today, to: today });
    expect(rangeDays("yesterday", today)).toEqual({ from: "2026-09-28", to: "2026-09-28" });
    expect(rangeDays("week", today)).toEqual({ from: "2026-09-28", to: today });
    expect(rangeDays("last-week", today)).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(rangeDays("month", today)).toEqual({ from: "2026-09-01", to: today });
    expect(rangeDays("last-month", today)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(rangeDays("30d", today)).toEqual({ from: "2026-08-31", to: today });
    expect(rangeDays("all", today)).toBeUndefined();
  });
});
