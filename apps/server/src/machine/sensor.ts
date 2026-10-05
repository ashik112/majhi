import type { MachineContainer, MachineReading } from "@majhi/shared";
import { IDLE_CPU_MIN_PCT } from "./busy.ts";

export const POLL_MS = 45_000;

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  kib: 1024,
  mb: 1_000_000,
  mib: 1024 ** 2,
  gb: 1_000_000_000,
  gib: 1024 ** 3,
};

/** `1.5GiB` or `512kB` to bytes. */
export function parseSize(text: string): number | undefined {
  const m = /^([\d.]+)\s*([a-zA-Z]+)$/.exec(text.trim());
  const unit = m?.[2] === undefined ? undefined : UNITS[m[2].toLowerCase()];
  if (m?.[1] === undefined || unit === undefined) return undefined;
  return Math.round(Number(m[1]) * unit);
}

/**
 * Containers of majhi (`majhi-run-*`, `majhi-preview-*`) from
 * `docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'`.
 */
export function parseDockerStats(out: string): MachineContainer[] {
  const rows: MachineContainer[] = [];
  for (const line of out.split("\n")) {
    const [name, cpu, mem] = line.split("\t");
    if (name === undefined || cpu === undefined || mem === undefined) continue;
    if (!name.startsWith("majhi-run-") && !name.startsWith("majhi-preview-")) continue;
    const cpuPct = Number(cpu.replace("%", ""));
    const memBytes = parseSize(mem.split("/")[0] ?? "");
    if (!Number.isFinite(cpuPct) || memBytes === undefined) continue;
    const limit = parseSize(mem.split("/")[1] ?? "");
    rows.push({
      name,
      cpuPct,
      memBytes,
      ...(limit === undefined || limit <= 0 ? {} : { memLimitBytes: limit }),
    });
  }
  return rows;
}

export interface MachineSensorDeps {
  /** The host helper's numbers, or undefined when it is not connected. */
  host: () => Promise<MachineReading["host"]>;
  /** Runs `docker` with these arguments and resolves with its stdout. */
  docker: (args: readonly string[]) => Promise<string>;
  now?: () => Date;
  /** Told when a poll changed whether the machine is busy, so the captain can be woken. */
  onChange?: () => void;
}

/**
 * Polls the computer and majhi's containers every 45 s and keeps the last reading. Reads never run
 * a command: everything asks `get()`. A failed half (helper offline, docker unreachable) is left out
 * of the reading.
 */
export class MachineSensor {
  private reading: MachineReading | undefined;
  private idleLowSince: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;

  constructor(private readonly deps: MachineSensorDeps) {}

  start(): void {
    if (this.timer !== undefined) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  get(): MachineReading | undefined {
    return this.reading;
  }

  /** How long idle CPU has stayed under the minimum, in ms. */
  idleLowMs(): number {
    return this.idleLowSince === undefined
      ? 0
      : (this.deps.now?.() ?? new Date()).getTime() - this.idleLowSince;
  }

  poll(): Promise<void> {
    this.polling ??= this.read().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async read(): Promise<void> {
    const now = this.deps.now?.() ?? new Date();
    const [host, containers] = await Promise.all([
      this.deps.host().catch(() => undefined),
      this.deps
        .docker(["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"])
        .then(parseDockerStats)
        .catch((): MachineContainer[] => []),
    ]);
    this.reading = { at: now.toISOString(), ...(host === undefined ? {} : { host }), containers };
    const low = host?.idleCpuPct !== undefined && host.idleCpuPct < IDLE_CPU_MIN_PCT;
    if (!low) this.idleLowSince = undefined;
    else this.idleLowSince ??= now.getTime();
    this.deps.onChange?.();
  }
}
