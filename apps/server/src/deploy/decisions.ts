import {
  deployBlockDecisionId,
  deployWaitDecisionId,
  type HomeDeploy,
  type OwnerDecision,
} from "@majhi/shared";

/**
 * A deploy that waits for the owner is a decision like any other: it counts in Needs you and the bell and opens
 * the task, and has Deploy right on the card. One per task, for the whole plan: every target that waits is listed on
 * it, and one click runs them in order (push, build, deploy, check, put back on a failure), not one card per target.
 */
export function waitingDeployDecisions(
  board: readonly HomeDeploy[],
  task: (id: string) => { title: string; org?: string | undefined; updatedAt: string } | undefined,
): OwnerDecision[] {
  const out: OwnerDecision[] = [];
  for (const deploy of board) {
    const found = task(deploy.task);
    // A block only the owner can clear: one card with the reason and the one thing to do. majhi's own blocks are lines
    // in the captain's log, and a deploy remote that is ahead is the task's own agent's job, never a card.
    const blocked = deploy.steps.filter((s) => s.state === "blocked" && s.clears === "owner");
    const first = blocked[0];
    if (found !== undefined && first !== undefined) {
      const reasons = [
        ...new Set(blocked.map((s) => `${s.project} ${s.env}: ${s.why ?? "it cannot run yet"}`)),
      ];
      out.push({
        id: deployBlockDecisionId(deploy.task),
        kind: "ship",
        ...(found.org === undefined ? {} : { org: found.org }),
        task: deploy.task,
        taskTitle: found.title,
        title: `Deploy cannot go: ${found.title}`.slice(0, 300),
        sentence: reasons.join(" ").slice(0, 500),
        blocked: (first.why ?? "It cannot run yet.").slice(0, 300),
        options: [],
        at: found.updatedAt,
        link: { kind: "task", id: deploy.task },
      });
    }
    const step = deploy.steps.find((s) => s.state === "waits-for-owner");
    if (step === undefined || found === undefined) continue;
    const targets = deploy.steps
      .filter((s) => s.state === "waits-for-owner" || s.state === "waits-for-previous")
      .map((s) => `${s.project} ${s.env}`);
    const where =
      targets.length > 1 ? `${targets.slice(0, -1).join(", ")} and ${targets.at(-1)}` : targets[0];
    out.push({
      id: deployWaitDecisionId(deploy.task, step.project, step.env),
      kind: "approval",
      ...(found.org === undefined ? {} : { org: found.org }),
      task: deploy.task,
      taskTitle: found.title,
      title: `Deploy to production: ${found.title}`.slice(0, 300),
      sentence: `${step.project} is merged. Deploying goes to ${where}, one after another. Each is pushed if its host lacks the commit, built, deployed and checked. One that fails is put back and the ones after it wait.`,
      options: [{ id: "run", label: "Deploy", primary: true }],
      at: found.updatedAt,
      link: { kind: "task", id: deploy.task },
    });
  }
  return out;
}
