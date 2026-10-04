import type { MachineHost, MachineReading } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { busyReason, machineLine, machineWarnings } from "./busy.ts";
import { parseDockerStats } from "./sensor.ts";

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

  it("refuses when the 1-minute load is over the cores", () => {
    expect(busyReason({ ...calm, load1: 27.1 })).toBe(
      "the machine is busy: load 27.1 on 10 cores, 12.0 GB free",
    );
  });

  it("refuses when free memory is under 10 percent", () => {
    expect(busyReason({ ...calm, memAvailableBytes: 2 * GB })).toBe(
      "the machine is busy: load 3.2 on 10 cores, 2.0 GB free",
    );
  });

  it("refuses under critical memory pressure and ignores a missing memory reading", () => {
    expect(busyReason({ ...calm, pressure: "critical" })).toContain("the machine is busy");
    const { memAvailableBytes: _gone, ...noMem } = calm;
    expect(busyReason(noMem)).toBeUndefined();
  });
});

describe("machine warnings", () => {
  it("warns on low idle CPU only after minutes, low memory and low disk", () => {
    const hot = { ...calm, idleCpuPct: 3 };
    expect(machineWarnings(hot, 60_000)).toEqual([]);
    expect(machineWarnings(hot, 5 * 60_000)).toEqual(["CPU has been under 15% idle for 5 minutes"]);
    expect(machineWarnings({ ...calm, memAvailableBytes: 3 * GB, diskFreeBytes: 4 * GB }, 0)).toEqual([
      "only 9% of memory is free",
      "4.0 GB of disk is free",
    ]);
  });
});

describe("docker stats", () => {
  it("keeps only majhi's runs and previews", () => {
    const out = [
      "majhi-run-acme-1-a\t182.50%\t1.5GiB / 8GiB",
      "majhi-preview-acme\t0.10%\t120MiB / 8GiB",
      "postgres\t5%\t90MiB / 8GiB",
    ].join("\n");
    expect(parseDockerStats(out)).toEqual([
      { name: "majhi-run-acme-1-a", cpuPct: 182.5, memBytes: Math.round(1.5 * 1024 ** 3) },
      { name: "majhi-preview-acme", cpuPct: 0.1, memBytes: 120 * 1024 ** 2 },
    ]);
  });

  it("makes the digest line", () => {
    const reading: MachineReading = {
      at: "2026-10-04T10:00:00.000Z",
      host: { ...calm, load1: 27.1 },
      containers: [{ name: "majhi-run-acme-1-a", cpuPct: 200, memBytes: 2 * GB }],
    };
    expect(machineLine(reading)).toBe(
      "load 27.1 on 10 cores, 70% CPU idle, 12.0 GB of 32.0 GB memory free (pressure normal), 120.0 GB disk free; 1 containers, heaviest majhi-run-acme-1-a 200% CPU 2.0 GB",
    );
  });
});
