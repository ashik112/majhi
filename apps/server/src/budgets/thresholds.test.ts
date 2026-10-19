import { describe, expect, it } from "vitest";
import { budgetTokens, budgetUse, weekWindow } from "./thresholds.ts";

describe("budgetUse", () => {
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
});

describe("budgetTokens", () => {
  it("counts input, output and cache write, and leaves cache reads and reasoning out", () => {
    expect(budgetTokens({ inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 500 })).toBe(1700);
  });
});

describe("weekWindow", () => {
  it("rolls over at local midnight on Monday, and Sunday night is still the old week", () => {
    expect(weekWindow("2026-10-04", "UTC").weekStart).toBe("2026-09-28");
    expect(weekWindow("2026-10-05", "UTC").weekStart).toBe("2026-10-05");
  });
});
