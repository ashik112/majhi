import type { DeployTarget } from "@majhi/shared";

/**
 * The guards a deploy passes before it starts, whoever asks. Pure: the facts are read by the caller, so the
 * same answer is given to the chore that decides, the command that deploys and the trail that shows why a
 * step waits. A rule says who deploys; none of these can be switched off by one.
 */

export interface DeployFacts {
  actor: "owner" | "captain";
  commit: string;
  /** The tip of the project's base branch now. Undefined: git could not say. */
  tip: string | undefined;
  /** The commit is exactly one a task's merge landed in. */
  landed: boolean;
  /** The project has test, build or lint checks, so a commit nothing merged has not been verified. */
  checksConfigured: boolean;
  /** The owner deploys a base tip no merge of majhi's produced. Never honoured for the captain. */
  confirmUnchecked: boolean;
  /** The environments listed before this one in the project, and whether each is live at this commit. */
  before: readonly { env: string; live: boolean }[];
  /** Why the captain rests in the workspace now (hours, a freeze). Only the captain's deploys wait for it. */
  rest?: string | undefined;
}

/** The sentence that says why this deploy may not start, or undefined when it may. */
export function deployRefusal(f: DeployFacts): string | undefined {
  if (f.tip === undefined) return "majhi could not read the project's base branch.";
  if (f.commit !== f.tip) {
    return `The base branch is at ${f.tip.slice(0, 7)} now, not at ${f.commit.slice(0, 7)}. Only the head of the base branch is deployed.`;
  }
  if (!f.landed && f.checksConfigured && !(f.actor === "owner" && f.confirmUnchecked)) {
    return `${f.commit.slice(0, 7)} was not merged by a task whose checks passed, so it has not been verified.`;
  }
  const waiting = f.before.find((b) => !b.live);
  if (waiting !== undefined) return `${waiting.env} is not live at ${f.commit.slice(0, 7)} yet.`;
  if (f.actor === "captain" && f.rest !== undefined) return `The captain rests: ${f.rest}`;
  return undefined;
}

/** Whether the deploy goes out past the verification check: the owner chose it, for a commit no merge produced. */
export function deployIsUnchecked(
  f: Pick<DeployFacts, "landed" | "checksConfigured" | "confirmUnchecked" | "actor">,
): boolean {
  return !f.landed && f.checksConfigured && f.actor === "owner" && f.confirmUnchecked;
}

/** The targets before `env` in the project's order: each must be live before this one goes. */
export function targetsBefore(targets: readonly DeployTarget[], env: string): string[] {
  const at = targets.findIndex((t) => t.env === env);
  return at < 0 ? [] : targets.slice(0, at).map((t) => t.env);
}

/** The rollback a target can really do, or why it cannot: a pipeline or a command cannot start an earlier commit. */
export function rollbackProblem(target: DeployTarget): string | undefined {
  if (target.rollback.kind === "ssh") return undefined;
  if (target.via.kind === "github-workflow" || target.via.kind === "vercel") return undefined;
  return target.via.kind === "gitlab-pipeline"
    ? "A GitLab pipeline starts from a branch, not from an earlier commit. Write the rollback command."
    : "An ssh command has no earlier commit to start from. Write the rollback command.";
}
