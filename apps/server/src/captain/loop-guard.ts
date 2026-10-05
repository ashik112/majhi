import type { CaptainRepo } from "./repo.ts";
import { LOOP_GUARD_ANSWERS } from "./rules.ts";

/**
 * The loop guard (D10). The captain answering one task's agent again and again, with the task going
 * nowhere, feeds a loop. After `LOOP_GUARD_ANSWERS` answers with no progress in between, the task is
 * paused for the owner. Progress is read from structured data only: the task's status and the head of
 * each of its branches, never from text. Any answer to the task counts, whichever card it is for.
 * The count lives in `captain_loop_guard`, so it survives a restart.
 */

export interface LoopGuardDeps {
  repo: Pick<CaptainRepo, "countAnswer">;
  /**
   * The task's progress mark: its status and the head of each branch. Two different marks mean
   * something moved between two answers. Undefined: the task is gone, nothing to guard.
   */
  mark: (task: string) => Promise<string | undefined>;
  /** Pauses the task for the owner with the loop reason, saying why in its room. */
  pause: (task: string, text: string) => Promise<void>;
}

export class LoopGuard {
  constructor(private readonly deps: LoopGuardDeps) {}

  /** The captain answered `task`. Returns whether this answer paused it. */
  async answered(task: string): Promise<boolean> {
    const mark = await this.deps.mark(task);
    if (mark === undefined) return false;
    const { pause } = this.deps.repo.countAnswer(task, mark, LOOP_GUARD_ANSWERS);
    if (!pause) return false;
    await this.deps.pause(
      task,
      `The captain answered ${task} ${LOOP_GUARD_ANSWERS} times with no progress in between. Paused for you: the agents may be going in circles.`,
    );
    return true;
  }
}
