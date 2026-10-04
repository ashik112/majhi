import { type AutonomyReport, PRIVATE, type TaskSummary } from "@majhi/shared";
import { columnOf } from "@/features/board/model";

/** The task states the dashboard counts. Done tasks are history, not a state to watch. */
export type StatId = "working" | "review" | "paused" | "inbox";

export const STAT_LABEL: Record<StatId, string> = {
  working: "Working",
  review: "Review",
  paused: "Paused",
  inbox: "Inbox",
};

export const STAT_ORDER: readonly StatId[] = ["working", "review", "paused", "inbox"];

/** Which count a task belongs to, or undefined for done work and finished MRs. */
export function statOf(task: Pick<TaskSummary, "status" | "working" | "asking">): StatId | undefined {
  if (task.status === "paused") return "paused";
  if (task.status === "review" || task.status === "mr") return "review";
  const column = columnOf(task);
  if (column === "inbox") return "inbox";
  if (column === "working") return "working";
  // A running task whose agents all stopped or wait on a question waits for the owner.
  return task.status === "running" ? "review" : undefined;
}

export function groupByStat(tasks: readonly TaskSummary[]): Record<StatId, TaskSummary[]> {
  const out: Record<StatId, TaskSummary[]> = { working: [], review: [], paused: [], inbox: [] };
  for (const t of tasks) {
    const stat = statOf(t);
    if (stat !== undefined) out[stat].push(t);
  }
  return out;
}

export interface OrgInfo {
  id: string;
  name: string;
  color?: string | undefined;
}

/** Colors for workspaces that have none of their own: theme tokens, so both themes read well. */
const FALLBACK = [
  "var(--c-blue)",
  "var(--c-accent)",
  "var(--c-green)",
  "var(--c-lamp-paused)",
  "var(--c-lamp-working)",
  "var(--c-amber)",
];

export function orgColor(orgs: readonly OrgInfo[], id: string): string {
  const i = orgs.findIndex((o) => o.id === id);
  return orgs[i]?.color ?? FALLBACK[(i < 0 ? orgs.length : i) % FALLBACK.length] ?? "var(--c-fg-muted)";
}

export function orgName(orgs: readonly OrgInfo[], id: string): string {
  return orgs.find((o) => o.id === id)?.name ?? (id === PRIVATE ? "Private" : id);
}

/** One row of the status chart: a workspace and how many tasks sit in each state. */
export interface StatusRow extends Record<StatId, number> {
  org: string;
  name: string;
}

/** Open tasks per workspace and state, workspaces with the most tasks first. */
export function statusRows(tasks: readonly TaskSummary[], orgs: readonly OrgInfo[]): StatusRow[] {
  const rows = new Map<string, StatusRow>();
  for (const t of tasks) {
    const stat = statOf(t);
    if (stat === undefined) continue;
    const id = t.org ?? PRIVATE;
    const row = rows.get(id) ?? {
      org: id,
      name: orgName(orgs, id),
      working: 0,
      review: 0,
      paused: 0,
      inbox: 0,
    };
    row[stat]++;
    rows.set(id, row);
  }
  const total = (r: StatusRow) => r.working + r.review + r.paused + r.inbox;
  return [...rows.values()].sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name));
}

/** One bar of "Tasks finished": a day and a count per workspace id. */
export type FinishedRow = { day: string; label: string; total: number } & Record<string, number | string>;

/** The workspaces that finished something in the window, busiest first, and one row per day. */
export function finishedRows(days: AutonomyReport["days"]): { rows: FinishedRow[]; orgs: string[] } {
  const totals = new Map<string, number>();
  for (const d of days) for (const o of d.orgs) totals.set(o.org, (totals.get(o.org) ?? 0) + o.count);
  const orgs = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([org]) => org);
  const rows = days.map((d) => {
    const row: FinishedRow = { day: d.day, label: dayLabel(d.day), total: 0 };
    for (const o of d.orgs) {
      row[o.org] = o.count;
      row.total += o.count;
    }
    return row;
  });
  return { rows, orgs };
}

/** "Oct 4" from `2026-10-04`, without going through a time zone. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export interface HourRow {
  hour: string;
  label: string;
  cost: number;
  total: number;
}

/** Hourly spend with the running total, labelled in the owner's zone. */
export function hourRows(hours: AutonomyReport["hours"], tz: string): HourRow[] {
  let total = 0;
  return hours.map((h) => {
    total = Math.round((total + h.cost) * 1_000_000) / 1_000_000;
    return {
      hour: h.start,
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
