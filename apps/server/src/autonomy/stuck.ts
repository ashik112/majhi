import type { AutonomyEvent, AutonomyWaiting, StuckTask, TaskStatus } from "@majhi/shared";

/** What the dashboard calls stuck: constants, so the owner reads one rule. */
export const IDLE_HOURS = 2;
export const WAIT_HOURS = 4;
export const FAILURES = 3;
export const REPEATS = 4;
const MAX = 12;
const HOUR = 3_600_000;

export interface StuckInput {
  now: Date;
  /** Autonomous tasks that are not done. */
  tasks: readonly {
    id: string;
    title: string;
    org?: string | undefined;
    status: TaskStatus;
    updatedAt: string;
  }[];
  /** The last day's feed, any order. */
  events: readonly AutonomyEvent[];
  waiting: readonly AutonomyWaiting[];
}

/**
 * Autonomous work that is not moving, longest first, one entry per task. The first rule that fits
 * wins: repeated failures, a loop (the same line over and over), a card waiting for the owner, a
 * running task with no update for hours, a task left in review.
 */
export function stuckTasks(input: StuckInput): StuckTask[] {
  const now = input.now.getTime();
  const byTask = new Map<string, AutonomyEvent[]>();
  for (const e of input.events) {
    if (e.task === undefined) continue;
    byTask.set(e.task, [...(byTask.get(e.task) ?? []), e]);
  }
  const out: StuckTask[] = [];
  for (const t of input.tasks) {
    const base = { task: t.id, title: t.title, ...(t.org === undefined ? {} : { org: t.org }) };
    const events = [...(byTask.get(t.id) ?? [])].sort((a, b) => a.at.localeCompare(b.at));
    const failed = events.filter((e) => e.outcome === "failed" || e.outcome === "refused");
    if (failed.length >= FAILURES) {
      out.push({
        ...base,
        kind: "failures",
        since: failed[0]?.at ?? t.updatedAt,
        text: `${failed.length} failed or refused calls in a day`,
      });
      continue;
    }
    const lines = new Map<string, AutonomyEvent[]>();
    for (const e of events) lines.set(e.text, [...(lines.get(e.text) ?? []), e]);
    const loop = [...lines.values()].find((l) => l.length >= REPEATS);
    if (loop !== undefined) {
      out.push({
        ...base,
        kind: "loop",
        since: loop[0]?.at ?? t.updatedAt,
        text: `Same step ${loop.length} times: ${loop[0]?.text ?? ""}`,
      });
      continue;
    }
    const card = input.waiting
      .filter((w) => w.task === t.id && w.at !== undefined && now - Date.parse(w.at) >= WAIT_HOURS * HOUR)
      .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))[0];
    if (card?.at !== undefined) {
      out.push({ ...base, kind: "waiting", since: card.at, text: card.text, item: card.item });
      continue;
    }
    const quiet = now - Date.parse(t.updatedAt);
    if (t.status === "running" && quiet >= IDLE_HOURS * HOUR) {
      out.push({ ...base, kind: "idle", since: t.updatedAt, text: "Running with no progress" });
    } else if ((t.status === "review" || t.status === "mr") && quiet >= WAIT_HOURS * HOUR) {
      out.push({ ...base, kind: "waiting", since: t.updatedAt, text: "In review, not shipped" });
    }
  }
  return out.sort((a, b) => a.since.localeCompare(b.since)).slice(0, MAX);
}
