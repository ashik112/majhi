import { describe, expect, it } from "vitest";
import { evaluate, FormulaError, formulaProblem, readNumber } from "./watch-formula.ts";

// DigitalOcean Monitoring answers in Prometheus' matrix shape: one series per CPU mode, cumulative seconds.
const cpu = {
  status: "success",
  data: {
    resultType: "matrix",
    result: [
      {
        metric: { mode: "idle" },
        values: [
          [1000, "900"],
          [1060, "945"],
        ],
      },
      {
        metric: { mode: "user" },
        values: [
          [1000, "50"],
          [1060, "95"],
        ],
      },
      {
        metric: { mode: "system" },
        values: [
          [1000, "10"],
          [1060, "20"],
        ],
      },
    ],
  },
};
const memory = (v: string) => ({
  data: {
    result: [
      {
        metric: {},
        values: [
          [1000, "1"],
          [1060, v],
        ],
      },
    ],
  },
});

describe("watch formulas", () => {
  it("turns DigitalOcean's CPU counters into a percent", () => {
    const all = readNumber(cpu, { path: "data.result.*.values", agg: "rate" });
    const idle = readNumber(cpu, { path: "data.result.*.values", agg: "rate", where: "metric.mode=idle" });
    expect(all).toBeCloseTo(100 / 60);
    expect(idle).toBeCloseTo(45 / 60);
    expect(evaluate("100*(1-b/a)", { a: all ?? 0, b: idle ?? 0 })).toBeCloseTo(55);
  });

  it("turns available and total memory into a used percent", () => {
    const a = readNumber(memory("2000"), { path: "data.result.*.values" });
    const b = readNumber(memory("8000"), { path: "data.result.*.values" });
    expect(evaluate("100*(1-a/b)", { a: a ?? 0, b: b ?? 0 })).toBe(75);
  });

  it("refuses anything but arithmetic, and a division by zero", () => {
    expect(formulaProblem("100*(1-a/b)")).toBeUndefined();
    expect(formulaProblem("process.exit()")).toBeDefined();
    expect(formulaProblem("a+")).toBeDefined();
    expect(() => evaluate("a/b", { a: 1, b: 0 })).toThrow(FormulaError);
    expect(() => evaluate("a+f", { a: 1 })).toThrow(FormulaError);
  });

  it("reads plain values, the last item and max over a window", () => {
    expect(readNumber({ account: { droplet_limit: 25 } }, { path: "account.droplet_limit" })).toBe(25);
    expect(readNumber({ v: [1, 9, 3] }, { path: "v", agg: "max" })).toBe(9);
    expect(
      readNumber(
        {
          v: [
            [1, "4"],
            [2, "7"],
          ],
        },
        { path: "v.-1.1" },
      ),
    ).toBe(7);
    expect(readNumber({ v: [] }, { path: "v" })).toBeUndefined();
  });
});
