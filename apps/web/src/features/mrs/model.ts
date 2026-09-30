import type { CiState, MergePolicy, MrState, Task, TaskRepo } from "@majhi/shared";

export const MR_STATE_LABEL: Record<MrState, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

export const CI_LABEL: Record<CiState, string> = {
  none: "No checks",
  pending: "Checks running",
  passing: "Checks passing",
  failing: "Checks failing",
};

export const CI_TONE: Record<CiState, string> = {
  none: "text-fg-faint",
  pending: "text-amber",
  passing: "text-green",
  failing: "text-red",
};

export const POLICY_LABEL: Record<MergePolicy, string> = {
  never: "Never: you merge on the host",
  approve: "Approve: majhi merges in order when you click",
  "auto-if-green": "Auto if green: majhi merges in order once checks pass",
};

/** The task's repos in merge order. Repos the order does not name (a stale answer) keep the task's order at the end. */
export function inMergeOrder(repos: readonly TaskRepo[], order: readonly string[] | undefined): TaskRepo[] {
  if (!order) return [...repos];
  const rank = (project: string) => {
    const at = order.indexOf(project);
    return at < 0 ? order.length : at;
  };
  return repos.toSorted((a, b) => rank(a.project) - rank(b.project));
}

/** Moves one project a place earlier (-1) or later (1); the same list when it is already at the end. */
export function moveProject(order: readonly string[], project: string, by: -1 | 1): string[] {
  const from = order.indexOf(project);
  const to = from + by;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

export type MrStep = "none" | "open" | "retry-open" | "merge" | "mark-merged" | "watch" | "done";

/**
 * What the owner can do next with the task's MRs. `open` when review work has no MR yet;
 * `retry-open` when some repos have an MR and others do not; then the policy decides who merges.
 */
export function nextMrStep(task: Pick<Task, "status" | "repos">, policy: MergePolicy): MrStep {
  if (task.status === "done") return "done";
  const withMr = task.repos.filter((r) => r.mr !== undefined);
  if (withMr.length === 0) return task.status === "review" && task.repos.length > 0 ? "open" : "none";
  if (withMr.length < task.repos.length) return "retry-open";
  if (withMr.every((r) => r.mr?.state === "merged")) return "done";
  if (policy === "never") return "mark-merged";
  return policy === "approve" ? "merge" : "watch";
}

/** Only tasks that are near MRs show the card: finished work, an open MR, or a done task that had one. */
export function showsMrCard(task: Pick<Task, "status" | "repos" | "kind">): boolean {
  if (task.kind === "chat" || task.repos.length === 0) return false;
  return task.status === "review" || task.status === "mr" || task.repos.some((r) => r.mr !== undefined);
}
