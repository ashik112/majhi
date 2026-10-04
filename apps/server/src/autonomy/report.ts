import { type AutonomyEvent, type AutonomyReport, type MachineReading, PRIVATE } from "@majhi/shared";
import { busyReason } from "../machine/busy.ts";
import { addDays, localDay } from "../usage/ranges.ts";

/** The charts of the Auto-pilot dashboard: pure sums over turns and feed events. */

const HOUR = 3_600_000;

/** One autonomous turn: when it ended and what it cost. */
export interface SpendTurn {
  at: string;
  cost: number;
  tokens: number;
}

/** Sums of floats drift in the last digits; a millionth of a dollar is plenty. */
function money(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Spend per hour from the day's start to the end of the hour `now` falls in. Hours count from the
 * start, so a day with a clock change still has its real length.
 */
export function hourlySpend(
  turns: readonly SpendTurn[],
  dayStartIso: string,
  now: Date,
): AutonomyReport["hours"] {
  const start = Date.parse(dayStartIso);
  const count = Math.max(1, Math.floor((now.getTime() - start) / HOUR) + 1);
  const hours = Array.from({ length: count }, (_, i) => ({
    start: new Date(start + i * HOUR).toISOString(),
    cost: 0,
    tokens: 0,
  }));
  for (const t of turns) {
    const i = Math.floor((Date.parse(t.at) - start) / HOUR);
    const h = hours[i];
    if (h === undefined) continue;
    h.cost = money(h.cost + t.cost);
    h.tokens += t.tokens;
  }
  return hours;
}

/** A task counts as finished once it reached review, an MR or done. */
function finishes(e: AutonomyEvent): boolean {
  return (
    e.kind === "task" &&
    e.task !== undefined &&
    (e.status === "review" || e.status === "mr" || e.status === "done")
  );
}

/**
 * Tasks finished per day and workspace, `days` days ending with `today` (oldest first). A task
 * counts once per day however many steps it took; an event with no workspace is Private.
 */
export function finishedByDay(
  events: readonly AutonomyEvent[],
  today: string,
  days: number,
  tz: string,
): AutonomyReport["days"] {
  const list = Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
  const seen = new Set<string>();
  const counts = new Map<string, Map<string, number>>(list.map((d) => [d, new Map()]));
  for (const e of events) {
    if (!finishes(e)) continue;
    const day = localDay(e.at, tz);
    const orgs = counts.get(day);
    if (orgs === undefined) continue;
    const key = `${day}|${e.task}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const org = e.org ?? PRIVATE;
    orgs.set(org, (orgs.get(org) ?? 0) + 1);
  }
  return list.map((day) => ({
    day,
    orgs: [...(counts.get(day) ?? [])]
      .map(([org, count]) => ({ org, count }))
      .sort((a, b) => b.count - a.count || a.org.localeCompare(b.org)),
  }));
}

/** The report's machine line, or nothing while the host helper is not connected. */
export function machineOf(reading: MachineReading | undefined): Pick<AutonomyReport, "machine"> {
  const host = reading?.host;
  if (reading === undefined || host === undefined) return {};
  const busy = busyReason(host);
  return {
    machine: {
      cores: host.cores,
      load1: host.load1,
      containers: reading.containers.length,
      ...(host.idleCpuPct === undefined ? {} : { idleCpuPct: host.idleCpuPct }),
      ...(host.memAvailableBytes === undefined || host.memTotalBytes <= 0
        ? {}
        : { memFreePct: (host.memAvailableBytes / host.memTotalBytes) * 100 }),
      ...(host.diskFreeBytes === undefined ? {} : { diskFreeGb: host.diskFreeBytes / 1_000_000_000 }),
      ...(busy === undefined ? {} : { busy }),
    },
  };
}
