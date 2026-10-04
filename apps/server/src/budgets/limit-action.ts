import { errorMessage } from "../errors.ts";
import { limitResetHeldLine } from "../runs/limit.ts";
import type { FiredAlert } from "./monitor.ts";

/** What the 100% action and its lift need of the run manager. */
export interface LimitRuns {
  /** Pauses runs a budget holds that wait with prompts queued. A turn in progress is left alone. */
  pauseLimited: () => Promise<void>;
  /** `account` is set when an account's usage limit paused the run, not a budget. */
  pausedForLimit: () => { task: string; agent: string; account?: string }[];
  resumeLimit: (task: string, agent: string, why: string) => void;
  /** Says once in the room that a paused run's account limit passed and it waits for the owner. */
  noteLimitReset: (task: string, agent: string, text: string) => void;
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
 *
 * An account's usage limit pauses a run the same way, and lifts at the mark's end through the same
 * `limited` check. A run in memory that an account limit paused waits for the owner instead when
 * the org's `resume.auto` is off. After a restart the store cannot tell the two kinds of pause
 * apart, so a stored task lifts whichever it was.
 */
export async function liftLimits(deps: {
  runs: Pick<LimitRuns, "pausedForLimit" | "resumeLimit" | "noteLimitReset">;
  limited: (task: string, agent: string) => Promise<string | undefined>;
  /** Whether a limit error still holds the account. */
  accountLimited?: (account: string) => Promise<boolean>;
  /** Whether the task's org resumes by itself. When not, a run an account limit paused waits for the owner. */
  autoResume?: (task: string) => Promise<boolean>;
  /** Tasks the store shows paused by a budget. */
  pausedTasks: () => { id: string; team: string[] }[];
  start: (task: string) => Promise<unknown>;
}): Promise<void> {
  const inMemory = deps.runs.pausedForLimit();
  for (const { task, agent, account } of inMemory) {
    if (account !== undefined) {
      if ((await deps.accountLimited?.(account)) === true) continue;
      if ((await deps.autoResume?.(task)) === false) {
        deps.runs.noteLimitReset(task, agent, limitResetHeldLine(account));
        continue;
      }
    }
    if ((await deps.limited(task, agent)) !== undefined) continue;
    deps.runs.resumeLimit(
      task,
      agent,
      account === undefined ? "no budget holds it any more" : `${account}'s limit reset`,
    );
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
