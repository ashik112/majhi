import type { AutonomyWaiting, StuckTask, TaskStatus } from "@majhi/shared";

/**
 * The one definition of stuck (D10): an open task that is quiet for N hours with no hold and no
 * pause. A running task is quiet after `IDLE_HOURS`; one left in review or as an open merge request
 * after `WAIT_HOURS`. A paused task or a task with a card waiting for the owner is held, not stuck:
 * Needs you lists those. Reads times and states, never text. Two numbers, because quiet time has no
 * structural proof.
 */
export const IDLE_HOURS = 2;
export const WAIT_HOURS = 4;
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
  /** Cards waiting for the owner: a task with one is held. */
  waiting: readonly AutonomyWaiting[];
}

/** Work that is quiet and held by nothing, longest first, one entry per task. */
export function stuckTasks(input: StuckInput): StuckTask[] {
  const now = input.now.getTime();
  const held = new Set(input.waiting.map((w) => w.task));
  const out: StuckTask[] = [];
  for (const t of input.tasks) {
    if (held.has(t.id)) continue;
    const quiet = now - Date.parse(t.updatedAt);
    const base = {
      task: t.id,
      title: t.title,
      since: t.updatedAt,
      ...(t.org === undefined ? {} : { org: t.org }),
    };
    if (t.status === "running" && quiet >= IDLE_HOURS * HOUR) {
      out.push({ ...base, kind: "idle", text: "Running with no progress" });
    } else if ((t.status === "review" || t.status === "mr") && quiet >= WAIT_HOURS * HOUR) {
      out.push({ ...base, kind: "waiting", text: "In review, not shipped" });
    }
  }
  return out.sort((a, b) => a.since.localeCompare(b.since)).slice(0, MAX);
}
