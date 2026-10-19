import { describe, expect, it } from "vitest";
import { type Kept, selectPrune } from "./retention.ts";

function daily(day: number, usable = true): Kept {
  const at = new Date(Date.UTC(2026, 8, 1) + day * 86_400_000).toISOString();
  return { name: `majhi-daily-${day}.age`, kind: "daily", at, usable };
}

describe("selectPrune", () => {
  it("never deletes the only good backup, even when damaged ones are newer and the limits are zero", () => {
    const all = [daily(1), daily(2, false), daily(3, false)];
    const drop = selectPrune(all, { daily: 0, weekly: 0, safety: 0 });
    expect(drop).not.toContain("majhi-daily-1.age");
    expect(drop.sort()).toEqual(["majhi-daily-2.age", "majhi-daily-3.age"]);
  });
});
