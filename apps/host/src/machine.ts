import { readFile } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import type { HostOs, MachineHost } from "@majhi/shared";
import type { ExecFn } from "./remount.ts";

const TOOL_TIMEOUT_MS = 8_000;

/** Bytes the system can hand back at once, from `vm_stat`: free, inactive, speculative and purgeable pages. */
export function parseVmStat(out: string): number | undefined {
  const size = /page size of (\d+) bytes/.exec(out)?.[1];
  if (size === undefined) return undefined;
  let pages = 0;
  let seen = 0;
  for (const name of ["free", "inactive", "speculative", "purgeable"]) {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?`, "m").exec(out);
    if (m?.[1] === undefined) continue;
    pages += Number(m[1]);
    seen++;
  }
  return seen === 0 ? undefined : pages * Number(size);
}

/** Idle percent from the `CPU usage:` line of `top -l 1`. */
export function parseTopIdle(out: string): number | undefined {
  const m = /CPU usage:.*?([\d.]+)% idle/.exec(out);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parsePressure(out: string): MachineHost["pressure"] {
  switch (out.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return undefined;
  }
}

/** Free bytes of the volume from `df -Pk <path>`. */
export function parseDfFree(out: string): number | undefined {
  const m = /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+\//.exec(out);
  return m?.[3] === undefined ? undefined : Number(m[3]) * 1024;
}

/** MemAvailable and MemTotal in bytes from /proc/meminfo. */
export function parseMeminfo(out: string): { total: number; available: number } | undefined {
  const kb = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(out);
    return m?.[1] === undefined ? undefined : Number(m[1]) * 1024;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  return total === undefined || available === undefined ? undefined : { total, available };
}

export interface MachineDeps {
  os: HostOs;
  exec: ExecFn;
  /** Where free disk is measured: the owner's home. */
  home: string;
  env: NodeJS.ProcessEnv;
}

/** Reads this computer's load, memory and free disk. Read-only, a second or so. */
export async function readMachine({ os, exec, home, env }: MachineDeps): Promise<MachineHost> {
  const run = async (file: string, args: string[]): Promise<string> =>
    (await exec(file, args, { cwd: home, env, timeout: TOOL_TIMEOUT_MS })).stdout;
  const quiet = (p: Promise<string>): Promise<string> => p.catch(() => "");
  const [load1 = 0, load5 = 0, load15 = 0] = loadavg();
  const disk = parseDfFree(await quiet(run("df", ["-Pk", home])));
  let memTotal = totalmem();
  let available: number | undefined;
  let pressure: MachineHost["pressure"];
  let idle: number | undefined;
  if (os === "macos") {
    const [vm, level, top] = await Promise.all([
      quiet(run("vm_stat", [])),
      quiet(run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])),
      quiet(run("top", ["-l", "1", "-n", "0", "-s", "0"])),
    ]);
    available = parseVmStat(vm);
    pressure = parsePressure(level);
    idle = parseTopIdle(top);
  } else {
    const info = parseMeminfo(await readFile("/proc/meminfo", "utf8").catch(() => ""));
    if (info !== undefined) {
      memTotal = info.total;
      available = info.available;
    }
  }
  return {
    cores: Math.max(1, cpus().length),
    load1,
    load5,
    load15,
    memTotalBytes: memTotal,
    ...(available === undefined ? {} : { memAvailableBytes: Math.min(available, memTotal) }),
    ...(pressure === undefined ? {} : { pressure }),
    ...(idle === undefined ? {} : { idleCpuPct: Math.min(100, idle) }),
    ...(disk === undefined ? {} : { diskFreeBytes: disk }),
  };
}
