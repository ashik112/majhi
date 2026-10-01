import { describe, expect, it } from "vitest";
import { alertLine } from "./alert-line.ts";
import type { FiredAlert } from "./monitor.ts";
import { budgetTokens, budgetUse, planAlerts, reached, weekWindow } from "./thresholds.ts";

describe("budgetUse", () => {
  it("measures tokens against a token budget", () => {
    expect(budgetUse({ tokens: 800, cost: 99 }, { tokens: 1000 })).toEqual({
      percent: 80,
      measure: "tokens",
    });
  });

  it("measures cost against a cost budget", () => {
    expect(budgetUse({ tokens: 5, cost: 3 }, { cost: 4 })).toEqual({ percent: 75, measure: "cost" });
  });

  it("follows whichever of the two is further along", () => {
    expect(budgetUse({ tokens: 500, cost: 9 }, { tokens: 1000, cost: 10 })).toEqual({
      percent: 90,
      measure: "cost",
    });
    expect(budgetUse({ tokens: 950, cost: 9 }, { tokens: 1000, cost: 10 })).toEqual({
      percent: 95,
      measure: "tokens",
    });
  });

  it("goes past 100 when exceeded", () => {
    expect(budgetUse({ tokens: 1500, cost: 0 }, { tokens: 1000 }).percent).toBe(150);
  });
});

describe("budgetTokens", () => {
  it("counts input, output and cache write, and leaves cache reads and reasoning out", () => {
    expect(budgetTokens({ inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 500 })).toBe(1700);
  });
});

describe("reached", () => {
  it("lists the thresholds a percent has reached", () => {
    expect(reached(79.9)).toEqual([]);
    expect(reached(80)).toEqual([80]);
    expect(reached(99.99)).toEqual([80]);
    expect(reached(100)).toEqual([80, 100]);
    expect(reached(250)).toEqual([80, 100]);
  });
});

describe("planAlerts", () => {
  it("fires 80 once, and nothing again at the same level", () => {
    expect(planAlerts(85, [])).toEqual({ rearm: [], fire: [80], announce: 80 });
    expect(planAlerts(86, [80])).toEqual({ rearm: [], fire: [], announce: undefined });
  });

  it("fires 100 after 80", () => {
    expect(planAlerts(100, [80])).toEqual({ rearm: [], fire: [100], announce: 100 });
    expect(planAlerts(130, [80, 100])).toEqual({ rearm: [], fire: [], announce: undefined });
  });

  it("records both when one turn jumps past 80 and 100, and says only the 100", () => {
    expect(planAlerts(120, [])).toEqual({ rearm: [], fire: [80, 100], announce: 100 });
  });

  it("re-arms only the thresholds a raised budget is now under", () => {
    // 91% after a raise: 100 comes back, 80 stays fired.
    expect(planAlerts(91, [80, 100])).toEqual({ rearm: [100], fire: [], announce: undefined });
    // 45% after a bigger raise: both come back.
    expect(planAlerts(45, [80, 100])).toEqual({ rearm: [80, 100], fire: [], announce: undefined });
    // Then crossing 80 again fires it again.
    expect(planAlerts(81, [])).toEqual({ rearm: [], fire: [80], announce: 80 });
  });
});

describe("weekWindow", () => {
  it("starts on Monday in the owner's zone and ends the next Monday", () => {
    // Wednesday 30 September 2026 in Dhaka (UTC+6).
    const w = weekWindow("2026-09-30", "Asia/Dhaka");
    expect(w.weekStart).toBe("2026-09-28");
    expect(w.start).toBe("2026-09-27T18:00:00.000Z");
    expect(w.end).toBe("2026-10-04T18:00:00.000Z");
  });

  it("rolls over at local midnight on Monday, and Sunday night is still the old week", () => {
    expect(weekWindow("2026-10-04", "UTC").weekStart).toBe("2026-09-28");
    expect(weekWindow("2026-10-05", "UTC").weekStart).toBe("2026-10-05");
  });
});

describe("alertLine", () => {
  const base: FiredAlert = {
    scope: "org",
    id: "acme",
    threshold: 80,
    budget: { tokens: 1_000_000 },
    spend: { tokens: 820_000, cost: 0 },
    week: { weekStart: "2026-09-28", start: "", end: "" },
    task: "ACM-1",
    percent: 82,
    measure: "tokens",
  };

  it("is a quiet line at 80 and a warning at 100", () => {
    expect(alertLine(base)).toEqual({
      level: "info",
      text: "Budget alert: org acme is at 82% of its weekly budget (820k of 1M tokens). The week resets Monday 2026-10-05.",
    });
    const at100 = alertLine({
      ...base,
      threshold: 100,
      percent: 103.4,
      spend: { tokens: 1_034_000, cost: 0 },
    });
    expect(at100.level).toBe("warn");
    expect(at100.text).toContain("is at 103% of its weekly budget (1.03M of 1M tokens)");
  });

  it("reads a cost budget in dollars", () => {
    const { text } = alertLine({
      ...base,
      scope: "account",
      id: "claude-acme",
      budget: { cost: 20 },
      spend: { tokens: 1, cost: 16.5 },
      percent: 82.5,
      measure: "cost",
    });
    expect(text).toContain("account claude-acme is at 82% of its weekly budget ($16.50 of $20.00)");
  });
});
