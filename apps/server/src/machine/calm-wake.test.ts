import { expect, it } from "vitest";
import { CalmWake } from "./calm-wake.ts";

it("wakes once per busy to calm flip, even when the load flaps within a minute", () => {
  const w = new CalmWake();
  const fired: boolean[] = [];
  const reads: [boolean, number][] = [
    [true, 0],
    [false, 1_000],
    [true, 10_000],
    [false, 20_000],
    [true, 30_000],
    [false, 40_000],
  ];
  for (const [busy, at] of reads) fired.push(w.read(busy, at));
  expect(fired).toEqual([false, true, false, false, false, false]);
});

it("wakes again after the gap", () => {
  const w = new CalmWake();
  w.read(true, 0);
  expect(w.read(false, 1_000)).toBe(true);
  w.read(true, 2_000);
  expect(w.read(false, 11 * 60_000)).toBe(true);
});
