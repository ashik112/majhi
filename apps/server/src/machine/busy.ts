import type { MachineContainer, MachineHost, MachineReading } from "@majhi/shared";

/**
 * When the owner's computer is too loaded for majhi to start more agent work, and when health warns.
 * Constants, not settings: the owner's rule is "do not make the computer unusable".
 */
export const MEMORY_FREE_MIN_PCT = 10;
export const DISK_FREE_MIN_BYTES = 10_000_000_000;
export const IDLE_CPU_MIN_PCT = 15;
/** Idle CPU must stay under the minimum this long before health warns. */
export const IDLE_LOW_WARN_MS = 3 * 60_000;

const GB = 1_000_000_000;

export function upperFirst(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

function memFreePct(host: MachineHost): number | undefined {
  if (host.memAvailableBytes === undefined || host.memTotalBytes <= 0) return undefined;
  return (host.memAvailableBytes / host.memTotalBytes) * 100;
}

/**
 * Why majhi must not start new work now, or undefined. Busy means the 1-minute load is over the core
 * count, free memory is under 10 percent, or the system reports critical memory pressure. No reading
 * (helper offline) never blocks a start.
 */
export function busyReason(host: MachineHost | undefined): string | undefined {
  if (host === undefined) return undefined;
  const pct = memFreePct(host);
  const busy =
    host.load1 > host.cores ||
    (pct !== undefined && pct < MEMORY_FREE_MIN_PCT) ||
    host.pressure === "critical";
  if (!busy) return undefined;
  const free = host.memAvailableBytes === undefined ? "" : `, ${gb(host.memAvailableBytes)} free`;
  return `the machine is busy: load ${host.load1.toFixed(1)} on ${host.cores} cores${free}`;
}

/** The runs and previews that use the most, heaviest first by CPU then memory. */
export function heaviest(containers: readonly MachineContainer[], n: number): MachineContainer[] {
  return [...containers].sort((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes).slice(0, n);
}

/** One line for the digest and the captain. */
export function machineLine(reading: MachineReading | undefined): string {
  const host = reading?.host;
  if (reading === undefined || host === undefined) return "not known (the host helper is not connected)";
  const parts = [`load ${host.load1.toFixed(1)} on ${host.cores} cores`];
  if (host.idleCpuPct !== undefined) parts.push(`${Math.round(host.idleCpuPct)}% CPU idle`);
  if (host.memAvailableBytes !== undefined) {
    parts.push(
      `${gb(host.memAvailableBytes)} of ${gb(host.memTotalBytes)} memory free${host.pressure === undefined ? "" : ` (pressure ${host.pressure})`}`,
    );
  }
  if (host.diskFreeBytes !== undefined) parts.push(`${gb(host.diskFreeBytes)} disk free`);
  const top = heaviest(reading.containers, 3);
  const runs =
    reading.containers.length === 0
      ? "no agent containers"
      : `${reading.containers.length} containers, heaviest ${top
          .map((c) => `${c.name} ${Math.round(c.cpuPct)}% CPU ${gb(c.memBytes)}`)
          .join(", ")}`;
  return `${parts.join(", ")}; ${runs}`;
}

/** Why health should warn, one sentence each. `idleLowMs`: how long idle CPU has stayed under the minimum. */
export function machineWarnings(host: MachineHost | undefined, idleLowMs: number): string[] {
  if (host === undefined) return [];
  const out: string[] = [];
  if (host.idleCpuPct !== undefined && host.idleCpuPct < IDLE_CPU_MIN_PCT && idleLowMs >= IDLE_LOW_WARN_MS) {
    out.push(`CPU has been under ${IDLE_CPU_MIN_PCT}% idle for ${Math.round(idleLowMs / 60_000)} minutes`);
  }
  const pct = memFreePct(host);
  if (pct !== undefined && pct < MEMORY_FREE_MIN_PCT) {
    out.push(`only ${Math.round(pct)}% of memory is free`);
  }
  if (host.diskFreeBytes !== undefined && host.diskFreeBytes < DISK_FREE_MIN_BYTES) {
    out.push(`${gb(host.diskFreeBytes)} of disk is free`);
  }
  return out;
}
