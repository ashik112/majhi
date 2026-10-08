import { deployWaitDecisionId, type HomeDeploy, type OwnerDecision } from "@majhi/shared";

/**
 * A deploy that waits for the owner is a decision like any other: it counts in Needs you and the bell and opens
 * the task, and has Run right on the card. One per task, for the first step that waits.
 */
export function waitingDeployDecisions(
  board: readonly HomeDeploy[],
  task: (id: string) => { title: string; org?: string | undefined; updatedAt: string } | undefined,
): OwnerDecision[] {
  const out: OwnerDecision[] = [];
  for (const deploy of board) {
    const step = deploy.steps.find((s) => s.state === "waits-for-owner");
    const found = task(deploy.task);
    if (step === undefined || found === undefined) continue;
    out.push({
      id: deployWaitDecisionId(deploy.task, step.project, step.env),
      kind: "approval",
      ...(found.org === undefined ? {} : { org: found.org }),
      task: deploy.task,
      taskTitle: found.title,
      title: `Deploy ${step.env}: ${found.title}`.slice(0, 300),
      sentence: `${step.project} is merged and its ${step.env} deploy waits for you. Run it here, or open the task to change the plan.`,
      options: [{ id: "run", label: "Run", primary: true }],
      at: found.updatedAt,
      link: { kind: "task", id: deploy.task },
    });
  }
  return out;
}
