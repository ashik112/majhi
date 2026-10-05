import { describe, expect, it } from "vitest";
import { dayBounds, dayStart, localDay } from "./ranges.ts";

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
});
