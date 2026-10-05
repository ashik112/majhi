import { describe, expect, it } from "vitest";
import { defaultHandoffCpus, defaultHandoffParallel } from "./limits.ts";

describe("hand-off check limits", () => {
  it("never take more than about a third of the cores together", () => {
    for (const cores of [2, 4, 8, 10, 12, 16, 24, 32, 64]) {
      const total = defaultHandoffCpus(cores) * defaultHandoffParallel(cores);
      // A small machine still gets one check of 2 CPUs.
      expect(total).toBeLessThanOrEqual(Math.max(2, Math.ceil(cores / 3)));
    }
  });

  it("gives a 10-core Mac one check of 2 CPUs", () => {
    expect([defaultHandoffCpus(10), defaultHandoffParallel(10)]).toEqual([2, 1]);
  });
});
