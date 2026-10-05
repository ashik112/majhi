import { describe, expect, it } from "vitest";
import { HEALTH_STALE_MS, healthRunDue } from "./health-run.ts";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("healthRunDue", () => {
  it("runs when nothing ran since majhi started", () => {
    expect(healthRunDue({ lastFullRunAt: undefined, running: false, now: NOW })).toBe(true);
  });

  it("runs when the last run is older than 15 minutes, and not before", () => {
    expect(healthRunDue({ lastFullRunAt: ago(HEALTH_STALE_MS + 1), running: false, now: NOW })).toBe(true);
    expect(healthRunDue({ lastFullRunAt: ago(HEALTH_STALE_MS), running: false, now: NOW })).toBe(false);
    expect(healthRunDue({ lastFullRunAt: ago(60_000), running: false, now: NOW })).toBe(false);
  });

  it("never starts a second run while one is going, even with stale results", () => {
    expect(healthRunDue({ lastFullRunAt: undefined, running: true, now: NOW })).toBe(false);
    expect(healthRunDue({ lastFullRunAt: ago(HEALTH_STALE_MS * 4), running: true, now: NOW })).toBe(false);
  });

  it("treats an unreadable date as never, and a future date as fresh", () => {
    expect(healthRunDue({ lastFullRunAt: "garbage", running: false, now: NOW })).toBe(true);
    const future = new Date(NOW + 60_000).toISOString();
    expect(healthRunDue({ lastFullRunAt: future, running: false, now: NOW })).toBe(false);
  });
});
