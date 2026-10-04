import { describe, expect, it } from "vitest";
import { type Kept, selectPrune, weekOf } from "./retention.ts";

const RULES = { daily: 7, weekly: 4, safety: 3 };

function daily(day: number, usable = true): Kept {
  const at = new Date(Date.UTC(2026, 8, 1) + day * 86_400_000).toISOString();
  return { name: `majhi-daily-${day}.age`, kind: "daily", at, usable };
}

describe("selectPrune", () => {
  it("keeps 7 daily and one per older week, and drops the rest", () => {
    // 60 days of dailies, one a day.
    const all = Array.from({ length: 60 }, (_, i) => daily(i));
    const drop = new Set(selectPrune(all, RULES));
    const kept = all.filter((b) => !drop.has(b.name));
    // 7 newest days + the newest daily of each of the next 4 weeks.
    expect(kept).toHaveLength(7 + 4);
    expect(kept.slice(-7).map((b) => b.name)).toEqual(all.slice(-7).map((b) => b.name));
    const weeks = new Set(kept.slice(0, 4).map((b) => weekOf(b.at)));
    expect(weeks.size).toBe(4);
  });

  it("keeps the newest few safety copies of each kind", () => {
    const all: Kept[] = Array.from({ length: 6 }, (_, i) => ({
      name: `majhi-before-update-${i}.age`,
      kind: "before-update" as const,
      at: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(),
      usable: true,
    }));
    const drop = selectPrune(all, RULES);
    expect(drop.sort()).toEqual([
      "majhi-before-update-0.age",
      "majhi-before-update-1.age",
      "majhi-before-update-2.age",
    ]);
  });

  it("never deletes the only good backup, even when damaged ones are newer and the limits are zero", () => {
    const all = [daily(1), daily(2, false), daily(3, false)];
    const drop = selectPrune(all, { daily: 0, weekly: 0, safety: 0 });
    expect(drop).not.toContain("majhi-daily-1.age");
    expect(drop.sort()).toEqual(["majhi-daily-2.age", "majhi-daily-3.age"]);
  });

  it("does not let damaged copies take a slot or push good ones out", () => {
    const all = [
      ...Array.from({ length: 7 }, (_, i) => daily(i)),
      ...Array.from({ length: 7 }, (_, i) => daily(10 + i, false)),
    ];
    const drop = new Set(selectPrune(all, RULES));
    for (const good of all.filter((b) => b.usable)) expect(drop.has(good.name)).toBe(false);
  });

  it("deletes nothing when no backup is good: a damaged copy may still be the only trace", () => {
    expect(selectPrune([daily(1, false), daily(2, false)], RULES)).toEqual([]);
  });

  it("keeps the newest good backup of any kind", () => {
    const only: Kept = {
      name: "majhi-before-restore-1.age",
      kind: "before-restore",
      at: "2026-09-01T00:00:00.000Z",
      usable: true,
    };
    expect(selectPrune([only], { daily: 0, weekly: 0, safety: 0 })).toEqual([]);
  });
});
