import { errorMessage } from "../errors.ts";
import type { FiredAlert } from "./monitor.ts";

/** What the 100% action and its lift need of the run manager. */
export interface LimitRuns {
  /** Pauses runs a budget holds that wait with prompts queued. A turn in progress is left alone. */
  pauseLimited: () => Promise<void>;
  pausedForLimit: () => { task: string; agent: string }[];
  resumeLimit: (task: string, agent: string, why: string) => void;
}

/**
 * What majhi does when a budget reaches 100% (SPEC 5.17): the alert has been said, now runs pause
 * with reason `limit`. For an org budget that is the runs of tasks in the org, for an account budget
 * the runs on the account. A turn that is running finishes: runs also check `limited` between
 * turns, so new runs and queued prompts wait, and every run in scope pauses at its next boundary.
 * It runs once per (scope, id, week), when the 100% alert fires, and never throws into the recorder.
 */
export async function atLimit(_alert: FiredAlert, runs: Pick<LimitRuns, "pauseLimited">): Promise<void> {
  await runs.pauseLimited();
}

/**
 * Resumes the runs a budget paused that no budget holds now: the owner raised or removed the
 * budget, or the week turned over. Runs the owner resumed by hand are not here: they left the
 * pause then, and `limitedFor` lets them through until a new 100% alert.
 *
 * After a restart no run is left in memory, but the task is still paused with `limit` in the
 * store: once no budget holds any of its agents, the task starts again (as majhi, not the owner,
 * so it is no hand resume and the next 100% alert pauses it).
 */
export async function liftLimits(deps: {
  runs: Pick<LimitRuns, "pausedForLimit" | "resumeLimit">;
  limited: (task: string, agent: string) => Promise<string | undefined>;
  /** Tasks the store shows paused by a budget. */
  pausedTasks: () => { id: string; team: string[] }[];
  start: (task: string) => Promise<unknown>;
}): Promise<void> {
  const inMemory = deps.runs.pausedForLimit();
  for (const { task, agent } of inMemory) {
    if ((await deps.limited(task, agent)) !== undefined) continue;
    deps.runs.resumeLimit(task, agent, "no budget holds it any more");
  }
  const held = new Set(inMemory.map((r) => r.task));
  for (const task of deps.pausedTasks()) {
    if (held.has(task.id)) continue;
    if (await someLimited(task, deps.limited)) continue;
    try {
      await deps.start(task.id);
    } catch (err) {
      console.error(`Could not resume ${task.id} after its budget pause: ${errorMessage(err)}`);
    }
  }
}

async function someLimited(
  task: { id: string; team: string[] },
  limited: (task: string, agent: string) => Promise<string | undefined>,
): Promise<boolean> {
  for (const agent of task.team) if ((await limited(task.id, agent)) !== undefined) return true;
  return false;
}
