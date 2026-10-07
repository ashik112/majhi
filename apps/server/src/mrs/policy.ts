import type { CiState, MrState } from "@majhi/shared";

/**
 * What to merge next (SPEC 5.5). Pure: the service reads the states from the hosts, asks here, and does
 * what it answers. Whether majhi merges at all is not decided here: the owner's click always may, and the
 * timer's merge runs only when the ship decision says the captain merges (`ShipPlanner`).
 */

/** With no CI reported, wait this long after the push before calling the MR green: checks may not have started. */
export const NO_CI_GRACE_MS = 2 * 60_000;

export interface RepoMrState {
  project: string;
  mr: { state: MrState; ci: CiState } | undefined;
  /** ISO time of the last push. */
  pushedAt?: string | undefined;
}

export type MergeDecision =
  | { action: "merge"; project: string }
  /** Nothing to do yet; try again later. */
  | { action: "wait"; project: string; reason: string }
  /** Something needs the owner. Say why in the room. */
  | { action: "stop"; project: string; reason: string }
  | { action: "done" };

export interface MergeQuery {
  /** `owner`: the owner clicked merge. `poll`: the captain's merge, on the timer or through a call. */
  trigger: "owner" | "poll";
  /** Repos in merge order. Repos without an MR are not in the list. */
  order: readonly RepoMrState[];
  nowMs: number;
}

export function nextMerge(q: MergeQuery): MergeDecision {
  const next = q.order.find((r) => r.mr?.state !== "merged");
  if (next === undefined) return { action: "done" };
  const project = next.project;
  if (next.mr === undefined) return { action: "stop", project, reason: `${project} has no merge request.` };
  if (next.mr.state === "closed") {
    return { action: "stop", project, reason: `The merge request of ${project} was closed without merging.` };
  }
  const ci = next.mr.ci;
  if (ci === "failing") {
    return { action: "stop", project, reason: `CI failed on ${project}. Fix it, then merge again.` };
  }
  if (ci === "pending") {
    return q.trigger === "poll"
      ? { action: "wait", project, reason: `CI is still running on ${project}.` }
      : {
          action: "stop",
          project,
          reason: `CI is still running on ${project}. Merge again when it has passed.`,
        };
  }
  if (ci === "none" && q.trigger === "poll") {
    const pushed = next.pushedAt === undefined ? Number.NaN : Date.parse(next.pushedAt);
    if (Number.isNaN(pushed) || q.nowMs - pushed < NO_CI_GRACE_MS) {
      return { action: "wait", project, reason: `No CI result on ${project} yet.` };
    }
  }
  return { action: "merge", project };
}
