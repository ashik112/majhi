import { CAPTAIN, didWords, OWNER, PRIVATE, type Task } from "@majhi/shared";
import type { CaptainRepo } from "../captain/repo.ts";
import { headsOf } from "../ship/heads.ts";

/**
 * "Nothing deploys": the captain planned the deploy of a task and the answer was an empty list. It is a line in the
 * captain's log (skipped, so it counts toward no cap), keyed by the task and its head, so the owner reads it and the
 * ship decision finds it with no store of its own. New commits void it: they may change what deploys.
 */
export interface NothingDeploys {
  record(task: Task, by: "captain" | "owner"): Promise<void>;
  has(task: Task): Promise<boolean>;
}

export interface NothingDeploysDeps {
  repo: Pick<CaptainRepo, "addAction" | "hasAction">;
  /** Today in the task's workspace, for the log line. */
  day(org: string): Promise<string>;
  now(): Date;
}

export function createNothingDeploys(deps: NothingDeploysDeps): NothingDeploys {
  const keyOf = async (task: Task): Promise<string> => `plan-none:${task.id}:${await headsOf(task.repos)}`;
  return {
    async record(task, by) {
      const org = task.org ?? PRIVATE;
      deps.repo.addAction({
        key: await keyOf(task),
        org,
        chore: "ship",
        day: await deps.day(org),
        at: deps.now().toISOString(),
        text: `Nothing deploys for ${task.id}: ${task.title}`,
        reason: `${didWords(by === "captain" ? CAPTAIN : OWNER, "planned", "its deploy and found nothing in the change that deploys")}`,
        task: task.id,
        outcome: "skipped",
      });
    },
    async has(task) {
      return deps.repo.hasAction(await keyOf(task));
    },
  };
}
