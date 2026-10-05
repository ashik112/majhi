import type { MachineHost } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { busyReason } from "./busy.ts";

const GB = 1_000_000_000;
const calm: MachineHost = {
  cores: 10,
  load1: 3.2,
  load5: 3,
  load15: 2,
  memTotalBytes: 32 * GB,
  memAvailableBytes: 12 * GB,
  pressure: "normal",
  idleCpuPct: 70,
  diskFreeBytes: 120 * GB,
};

describe("when the machine is busy", () => {
  it("allows starts on a calm machine and with no reading", () => {
    expect(busyReason(calm)).toBeUndefined();
    expect(busyReason(undefined)).toBeUndefined();
  });

  it("refuses when the 1-minute load is over the cores or free memory is under 10 percent", () => {
    expect(busyReason({ ...calm, load1: 27.1 })).toBeDefined();
    expect(busyReason({ ...calm, memAvailableBytes: 2 * GB })).toBeDefined();
  });

  it("refuses under critical memory pressure and ignores a missing memory reading", () => {
    expect(busyReason({ ...calm, pressure: "critical" })).toBeDefined();
    const { memAvailableBytes: _gone, ...noMem } = calm;
    expect(busyReason(noMem)).toBeUndefined();
  });
});
