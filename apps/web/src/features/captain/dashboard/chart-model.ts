import type { AutonomyReport, AutonomyStatus } from "@majhi/shared";

/** "Oct 4": a day id as the owner reads it. */
export function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export interface HourRow {
  label: string;
  cost: number;
  total: number;
}

/** Today's spend per hour with the running total, labelled in the owner's zone. */
export function hourRows(hours: AutonomyReport["hours"], tz: string): HourRow[] {
  let total = 0;
  return hours.map((h) => {
    total += h.cost;
    return {
      label: new Date(h.start).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: tz,
      }),
      cost: h.cost,
      total,
    };
  });
}

export interface StackRows {
  rows: Record<string, number | string>[];
  orgs: string[];
}

/** One row per day with a number per workspace, for a stacked bar. */
export function stackRows(
  days: readonly { day: string; orgs: readonly { org: string; count?: number; cost?: number }[] }[],
): StackRows {
  const orgs = new Set<string>();
  const rows = days.map((d) => {
    const row: Record<string, number | string> = { label: dayLabel(d.day) };
    for (const o of d.orgs) {
      orgs.add(o.org);
      row[o.org] = o.count ?? o.cost ?? 0;
    }
    return row;
  });
  return { rows, orgs: [...orgs].sort() };
}

export interface AccountBar {
  id: string;
  weekly?: number | undefined;
  window?: number | undefined;
  resetsAt?: string | undefined;
  blocked: boolean;
}

/** Accounts with the most used week first, so the ones near their limit lead. */
export function accountBars(accounts: AutonomyStatus["accounts"]): AccountBar[] {
  return accounts
    .map((a) => ({
      id: a.id,
      weekly: a.weekly?.usedPct,
      window: a.window?.usedPct,
      resetsAt: a.weekly?.resetsAt ?? a.blocked?.until ?? a.window?.resetsAt,
      blocked: a.blocked !== undefined,
    }))
    .sort((a, b) => (b.weekly ?? -1) - (a.weekly ?? -1));
}
