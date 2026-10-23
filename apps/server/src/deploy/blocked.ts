import type { DeployStepView } from "@majhi/shared";
import type { Evaluated } from "./service.ts";

/**
 * Every reason a planned deploy step cannot go on has one of two outcomes, so none is silent. `owner`: only the owner
 * can clear it, so it is one card in Needs you with the reason and the one thing to do. `majhi`: majhi clears it itself
 * or it clears with time, so it is a line in the captain's log (and, for a deploy remote that is ahead, the task's own
 * agent is woken). Typed by the kind `evaluate` refuses with: a new kind does not compile until it has an outcome here.
 */
export type BlockKind = Extract<Evaluated, { ok: false }>["kind"];

interface Outcome {
  clears: NonNullable<DeployStepView["clears"]>;
  /** What the owner does, in a sentence. Only for `owner`. */
  action?: string;
}

export const BLOCKS: Record<BlockKind, Outcome> = {
  // The project's deploy setup is wrong or missing, or the host answered with a problem (a sign-in, a route).
  setup: {
    clears: "owner",
    action: "Fix it under the project's Deploys or the workspace's Git accounts, and majhi reads it again.",
  },
  // No copy of the base branch to read, or a remote that cannot be reached.
  unreadable: {
    clears: "owner",
    action: "Check the project's remotes and its sign-in under Projects, and majhi reads it again.",
  },
  // The head is a commit no task of majhi merged: only the owner may deploy what nobody checked.
  unverified: {
    clears: "owner",
    action:
      "Look at that commit. If it is fine, deploy it from the project's Deploys and confirm it was not checked.",
  },
  // The host that deploys lacks the commit and majhi may only push it to a GitLab host.
  unpushed: { clears: "owner", action: "Push the base branch to that remote, and majhi reads it again." },
  // The head moved after the step was planned: majhi reads the plan again against the new head.
  moved: { clears: "majhi" },
  // Working hours or a freeze: the captain deploys when they end.
  rest: { clears: "majhi" },
  // An earlier step of the plan is not live yet: the plan goes on by itself.
  previous: { clears: "majhi" },
  // A deploy remote has commits the source lacks: the task's agent brings them in, and the task lands again.
  sync: { clears: "majhi" },
};

/**
 * What happens to a step now, in a sentence the captain can repeat to the owner. It never promises a card: it says
 * what the step waits for, from the same state the trail and the cards read.
 */
export function stepLine(step: Pick<DeployStepView, "state" | "why">): string {
  switch (step.state) {
    case "preparing":
      return step.why ?? "majhi is preparing the deploy through the task's own agent.";
    case "blocked":
      return step.why ?? "It cannot run yet.";
    case "waits-for-owner":
      return "Waits for the owner: one Deploy card for the whole task.";
    case "captain-next":
      return "The captain deploys it next.";
    case "waits-for-previous":
      return step.why ?? "Waits for the step before it.";
    case "planned":
    case "none":
      return "Waits for the task to merge. Nothing is asked of the owner until it has.";
    case "held":
      return "Held for the owner.";
    case "queued":
    case "running":
    case "verifying":
      return "Going out now.";
    case "live":
      return "Live.";
    case "failed":
    case "rolled-back":
      return step.why ?? "It did not go live.";
  }
}

/** The sentence a blocked step carries: why, then what the owner does when it is theirs to clear. */
export function blockedWhy(kind: BlockKind, why: string): string {
  const action = BLOCKS[kind].action;
  const plain = why.endsWith(".") ? why : `${why}.`;
  return action === undefined ? plain : `${plain} ${action}`;
}
