import {
  type AutonomyReport,
  type AutonomyStatus,
  type OwnerDecision,
  PRIVATE,
  type TaskSummary,
} from "@majhi/shared";
import { workspaceOf } from "@/features/decisions/model";
import type { LogEntry } from "../log-model";

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

// Time words ----------------------------------------------------------------

const MIN = 60_000;
const HOUR = 3_600_000;

/** "12m", "3h 05m", "2d": how long, for elapsed time and ages. */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

/** "14:02" in the owner's zone, or "Fri 09:00" when it is not today. */
export function atTime(iso: string, nowMs: number, tz: string | undefined): string {
  const at = new Date(iso);
  const zone = tz === undefined ? {} : { timeZone: tz };
  const day = (d: Date) => d.toLocaleDateString("en-CA", zone);
  return at.toLocaleString(undefined, {
    ...(day(at) === day(new Date(nowMs)) ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...zone,
  });
}

// Spend pace ----------------------------------------------------------------

export interface Pace {
  /** Dollars per hour over the last three hours (or since midnight, when that is shorter). */
  perHour: number;
  /** Spend at the end of the day if it goes on like this. */
  projected: number;
  /** When the cap is reached at this rate, if that is before the day ends. */
  capAt?: number;
}

/** Burn rate and where the day ends, from today's hourly spend. Undefined before there is any spend. */
export function pace(
  hours: AutonomyReport["hours"],
  used: number,
  cap: number | undefined,
  nowMs: number,
  endsAt: string,
): Pace | undefined {
  const first = hours[0];
  if (first === undefined || used <= 0) return undefined;
  const sinceStart = (nowMs - Date.parse(first.start)) / HOUR;
  const window = Math.max(0.25, Math.min(3, sinceStart));
  const from = nowMs - window * HOUR;
  const recent = hours.reduce((n, h) => {
    const start = Date.parse(h.start);
    // An hour counts in full when it began inside the window, which is close enough for a trend.
    return start + HOUR > from ? n + h.cost : n;
  }, 0);
  const perHour = recent / window;
  const left = Math.max(0, (Date.parse(endsAt) - nowMs) / HOUR);
  const projected = used + perHour * left;
  const capAt =
    cap !== undefined && used < cap && perHour > 0 && used + perHour * left > cap
      ? nowMs + ((cap - used) / perHour) * HOUR
      : undefined;
  return { perHour, projected, ...(capAt === undefined ? {} : { capAt }) };
}

// Workspace rows ------------------------------------------------------------

const PAUSE_WORD: Record<string, string> = {
  limit: "at its limit",
  offline: "offline",
  error: "error",
  owner: "you paused it",
  loop: "loop",
  blocked: "blocked",
  "signed-out": "signed out",
};

export interface TaskLine {
  task: string;
  title: string;
}

export interface WorkspaceRow {
  org: string;
  name: string;
  color: string;
  /** The captain's lane: in a turn now, resting (and why), or idle. */
  lane: "working" | "resting" | "idle";
  resting?: string | undefined;
  running: {
    count: number;
    first?: (TaskLine & { agents: string[]; sinceMs?: number | undefined }) | undefined;
  };
  blocked: { count: number; first?: (TaskLine & { reason: string }) | undefined };
  /** `ready`: how many of them wait on you to ship. */
  review: { count: number; ready: number; first?: TaskLine | undefined; shipId?: string | undefined };
  /** Decisions waiting for the owner: how many, the oldest one and how long it has waited. */
  waiting: { count: number; oldest?: { id: string; at: string; title: string } | undefined };
  last?: { sentence: string; at: string; task?: string | undefined } | undefined;
}

/**
 * One row per workspace: every workspace where the captain has a lane, then any other with open
 * tasks. Each cell is a count and the one entry worth a glance (the longest running task, the first
 * pause, the oldest decision), so a row stays on one line.
 */
export function workspaceRows(
  tasks: readonly TaskSummary[],
  autonomy: AutonomyStatus,
  decisions: readonly OwnerDecision[],
  orgs: readonly OrgInfo[],
  log: readonly Pick<LogEntry, "org" | "sentence" | "at" | "task">[],
  nowMs: number,
): WorkspaceRow[] {
  const ids = autonomy.lanes.map((l) => l.org);
  for (const t of tasks) {
    const id = t.org ?? PRIVATE;
    if (t.status !== "done" && !ids.includes(id)) ids.push(id);
  }
  const lanes = new Map(autonomy.lanes.map((l) => [l.org, l]));
  const now = new Map(autonomy.now.map((n) => [n.task, n]));
  return ids.map((org) => {
    const lane = lanes.get(org);
    const mine = tasks.filter((t) => (t.org ?? PRIVATE) === org);
    const running = mine
      .filter((t) => t.status === "running")
      .map((t) => ({ t, since: now.get(t.id)?.since }))
      .sort((a, b) => (a.since ?? "~").localeCompare(b.since ?? "~"));
    const paused = mine.filter((t) => t.status === "paused");
    const review = mine.filter((t) => t.status === "review" || t.status === "mr");
    const decided = decisions.filter((d) => workspaceOf(d) === org);
    const ships = decided.filter((d) => d.kind === "ship");
    const oldest = [...decided].sort((a, b) => a.at.localeCompare(b.at))[0];
    const r = running[0];
    const p = paused[0];
    const last = log.find((e) => (e.org ?? PRIVATE) === org);
    return {
      org,
      name: lane?.name ?? orgName(orgs, org),
      color: orgColor(orgs, org),
      lane: lane?.working ? "working" : lane?.resting ? "resting" : "idle",
      resting: lane?.resting,
      running: {
        count: running.length,
        first:
          r === undefined
            ? undefined
            : {
                task: r.t.id,
                title: r.t.title,
                agents: r.t.working.length > 0 ? r.t.working : r.t.team.slice(0, 1),
                sinceMs: r.since === undefined ? undefined : nowMs - Date.parse(r.since),
              },
      },
      blocked: {
        count: paused.length,
        first:
          p === undefined
            ? undefined
            : {
                task: p.id,
                title: p.title,
                reason: now.get(p.id)?.pause?.label ?? PAUSE_WORD[p.pausedReason ?? "owner"] ?? "paused",
              },
      },
      review: {
        count: review.length,
        ready: ships.length,
        first: review[0] === undefined ? undefined : { task: review[0].id, title: review[0].title },
        shipId: ships[0]?.id,
      },
      waiting: {
        count: decided.length,
        oldest:
          oldest === undefined
            ? undefined
            : { id: oldest.id, at: oldest.at, title: oldest.taskTitle ?? oldest.title },
      },
      last: last === undefined ? undefined : { sentence: last.sentence, at: last.at, task: last.task?.id },
    };
  });
}
