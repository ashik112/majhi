import { describe, expect, it } from "vitest";
import { parseDfFree, parseMeminfo, parsePressure, parseTopIdle, parseVmStat } from "./machine.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            500000.
Pages inactive:                           20000.
Pages speculative:                         5000.
Pages purgeable:                           1000.
Pages wired down:                        100000.
`;

describe("macOS readings", () => {
  it("counts free, inactive, speculative and purgeable pages as available", () => {
    expect(parseVmStat(VM_STAT)).toBe(36_000 * 16384);
  });

  it("gives nothing for output it does not know", () => {
    expect(parseVmStat("nope")).toBeUndefined();
  });

  it("reads idle CPU from top", () => {
    const top =
      "Processes: 600 total\nLoad Avg: 27.1, 20.2, 15.3\nCPU usage: 61.5% user, 38.5% sys, 0.0% idle\n";
    expect(parseTopIdle(top)).toBe(0);
    expect(parseTopIdle("CPU usage: 5.2% user, 10.1% sys, 84.7% idle")).toBe(84.7);
  });

  it("maps the memory pressure level", () => {
    expect(parsePressure("1\n")).toBe("normal");
    expect(parsePressure("2")).toBe("warn");
    expect(parsePressure("4")).toBe("critical");
    expect(parsePressure("")).toBeUndefined();
  });

  it("reads free disk from df -Pk", () => {
    const df = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s5 971350180 700000000 150000000 83% /System/Volumes/Data
`;
    expect(parseDfFree(df)).toBe(150_000_000 * 1024);
  });
});

describe("Linux readings", () => {
  it("reads MemAvailable", () => {
    const info = "MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:    8000000 kB\n";
    expect(parseMeminfo(info)).toEqual({ total: 32_000_000 * 1024, available: 8_000_000 * 1024 });
  });
});
