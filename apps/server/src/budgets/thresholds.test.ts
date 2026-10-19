import { describe, expect, it } from "vitest";
import { budgetTokens, budgetUse, weekWindow } from "./thresholds.ts";

describe("budgetTokens", () => {
  it("counts input, output and cache write, and leaves cache reads and reasoning out", () => {
    expect(budgetTokens({ inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 500 })).toBe(1700);
  });
});
