import { describe, expect, it } from "vitest";
import { MemoryWatch } from "./memwatch.ts";

const GB = 1024 ** 3;
const box = (name: string, used: number) => ({
  name,
  cpuPct: 50,
  memBytes: used * GB,
  memLimitBytes: 4 * GB,
});

describe("MemoryWatch", () => {
  it("reports a run at its limit once, after it stays there, and again after it recovers", () => {
    const w = new MemoryWatch();
    expect(w.read([box("majhi-run-a", 3.9)])).toEqual([]);
    expect(w.read([box("majhi-run-a", 3.9)])).toEqual(["majhi-run-a"]);
    expect(w.read([box("majhi-run-a", 3.95)])).toEqual([]);
    expect(w.read([box("majhi-run-a", 1)])).toEqual([]);
    w.read([box("majhi-run-a", 3.9)]);
    expect(w.read([box("majhi-run-a", 3.9)])).toEqual(["majhi-run-a"]);
  });

  it("ignores a spike, previews and containers with no limit", () => {
    const w = new MemoryWatch();
    w.read([box("majhi-run-a", 3.9)]);
    expect(w.read([box("majhi-run-a", 2)])).toEqual([]);
    expect(w.read([box("majhi-preview-a", 3.9)])).toEqual([]);
    expect(w.read([box("majhi-preview-a", 3.9)])).toEqual([]);
    expect(w.read([{ name: "majhi-run-b", cpuPct: 1, memBytes: 9 * GB }])).toEqual([]);
  });
});
