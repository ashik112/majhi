import { mrCiDecisionId, type OwnerDecision, type Task } from "@majhi/shared";

/** What "Fix with agent" says to the lead of a task whose merge request fails its checks. */
export const FIX_MR_CHECKS_TEXT =
  "The checks of the merge request failed. Read the failure on the host, fix it, commit, and say when it is done.";

type MrTask = Pick<Task, "id" | "title" | "org" | "status" | "repos" | "team" | "updatedAt">;

/**
 * A merge request that fails its checks waits for the owner like any other decision. Nobody but the owner takes a
 * task with an open merge request back to work, so the lead is told by the owner's click, here or on the task.
 */
export function failingMrDecisions(tasks: readonly MrTask[]): OwnerDecision[] {
  const out: OwnerDecision[] = [];
  for (const task of tasks) {
    if (task.status !== "mr") continue;
    const failing = task.repos.filter((r) => r.mr?.state === "open" && r.mr.ci === "failing");
    if (failing.length === 0) continue;
    const names = failing.map((r) => `${r.project} !${r.mr?.number}`).join(", ");
    const lead = task.team[0];
    out.push({
      id: mrCiDecisionId(task.id),
      kind: "ship",
      ...(task.org === undefined ? {} : { org: task.org }),
      task: task.id,
      taskTitle: task.title,
      title: `Checks failed: ${task.title}`.slice(0, 300),
      sentence: `The checks failed on ${names}. ${lead === undefined ? "The task has no agent." : `@${lead} has not been asked to fix them.`}`.slice(
        0,
        500,
      ),
      options: lead === undefined ? [] : [{ id: "fix", label: "Fix with agent", primary: true }],
      at: task.updatedAt,
      link: { kind: "task", id: task.id },
    });
  }
  return out;
}
