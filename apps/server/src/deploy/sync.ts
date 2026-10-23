import type { Task } from "@majhi/shared";
import type { DeployHeld } from "../captain/ports.ts";
import { UserError } from "../errors.ts";
import { type SyncHead, syncFact } from "./git.ts";
import type { DeployStep } from "./plan.ts";

/**
 * A deploy remote that has commits the source remote lacks is not a block: it is a step of the task's own deploy.
 * The task's own agent, in the task's own room, brings the deploy remote's base into the task's branch, resolves what
 * conflicts keeping both sides' intent and runs the project's checks. The task then lands again through its normal
 * hand-off (its merge request or push, under the workspace's authority), and the deploy plan reads the remotes again.
 * Nothing here makes a task, a subtask or a follow-up.
 */

export interface DeploySyncDeps {
  tasks: {
    get(id: string): Task | undefined;
    /** Opens a finished task again (its worktree comes back from its branch when the agent is written to). */
    reopen(id: string): Promise<Task>;
    /** The one message to the task's lead, from majhi. */
    send(input: {
      task: string;
      text: string;
      attachments: string[];
      mode: "queue";
      by: string;
    }): Promise<unknown>;
    setStatusLines(id: string, lines: { now?: string }): Promise<unknown>;
  };
  /** Reads a project's remotes again so the agent merges what the deploy remote has now. A sentence when it could not. */
  refresh(project: string, remotes: readonly string[], base: string): Promise<string | undefined>;
  /** One line in the task's room. */
  note(task: string, key: string, level: "info" | "warn", text: string): void;
}

/**
 * The steps of a task that majhi clears itself, read from the plan: a deploy remote that is ahead (one entry for a
 * project and the two tips, though several environments wait on it) and a block that clears with time.
 */
export function heldSteps(task: Pick<Task, "id" | "title">, steps: readonly DeployStep[]): DeployHeld[] {
  const out: DeployHeld[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    const waits = s.state === "blocked" && s.clears === "majhi";
    if (s.state !== "preparing" && !waits) continue;
    if (s.sync !== undefined) {
      const key = `${s.project}:${s.sync.sourceTip}:${s.sync.deployTip}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push({
      task: task.id,
      title: task.title,
      project: s.project,
      env: s.env,
      why: s.why ?? "",
      sync: s.sync,
    });
  }
  return out;
}

/** The one job the task's agent is given, in plain words. */
export function syncJob(h: SyncHead, branch: string): string {
  const theirs = `${h.deployRemote}/${h.base}`;
  const ours = `${h.sourceRemote}/${h.base}`;
  const files =
    h.conflicts.length === 0
      ? "A test merge is clean."
      : `A test merge conflicts in ${h.conflicts.slice(0, 10).join(", ")}${h.conflicts.length > 10 ? " and more" : ""}.`;
  return [
    `Preparing the deploy. ${syncFact(h)}. The merged work cannot be pushed to ${h.deployRemote} until its commits are in ${ours}.`,
    `${theirs} is fetched in this repo. Merge it into your branch ${branch}: \`git merge ${theirs}\`. Your fix may already be on ${ours}, and the branch may start from it; merge ${theirs} all the same. ${files}`,
    "Resolve each conflict keeping what both sides meant. Then run typecheck and the tests of the files you touched. If a check fails and you cannot fix it, do not commit: say what failed.",
    `Do not push and do not merge into ${h.base}: majhi lands the task again by its normal hand-off, then deploys. If a conflict needs a choice only the owner can make, ask one question with options in this room instead of guessing. Say what you did in one message when you are done.`,
  ].join("\n");
}

export class DeploySync {
  constructor(private readonly deps: DeploySyncDeps) {}

  /** Wakes the task's lead with the job, once per call: the caller keys it by the two tips. */
  async prepare(held: DeployHeld): Promise<void> {
    const sync = held.sync;
    if (sync === undefined) return;
    const found = this.deps.tasks.get(held.task);
    if (found === undefined) throw new UserError(`There is no task ${held.task}.`, 404);
    const lead = found.team[0];
    if (lead === undefined) throw new UserError(`${held.task} has no agent to bring the commits in.`, 409);
    const repo = found.repos.find((r) => r.project === held.project);
    if (repo === undefined) throw new UserError(`${held.task} has no work in ${held.project}.`, 409);
    // The deploy remote is read again now, so the agent merges the commits it has at this moment.
    const problem = await this.deps.refresh(held.project, [sync.deployRemote], sync.base);
    if (problem !== undefined) throw new UserError(problem, 409);
    const task = found.status === "done" ? await this.deps.tasks.reopen(found.id) : found;
    this.deps.note(
      task.id,
      `deploy-sync:${held.project}:${sync.sourceTip}:${sync.deployTip}`,
      "info",
      `${syncFact(sync)}. The deploy waits for them: @${lead} brings ${sync.deployRemote}/${sync.base} into ${repo.branch}, then the task lands again and deploys.`,
    );
    await this.deps.tasks.setStatusLines(task.id, {
      now: `Bringing ${sync.deployRemote}/${sync.base} into ${repo.branch} so the work can deploy`,
    });
    await this.deps.tasks.send({
      task: task.id,
      text: syncJob(sync, repo.branch),
      attachments: [],
      mode: "queue",
      by: "majhi",
    });
  }
}
