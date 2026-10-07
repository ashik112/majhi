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
  /** The steps of the task's plan before this one, by name ("storefront staging"), and whether each is live at this commit. */
  before: readonly { env: string; live: boolean }[];
  /** Why the captain rests in the workspace now (hours, a freeze). Only the captain's deploys wait for it. */
  rest?: string | undefined;
}

/** Why a deploy may not start: the sentence, and which guard said it, so a trail can tell waiting from blocked. */
export interface DeployRefusal {
  kind: "unreadable" | "moved" | "unverified" | "previous" | "rest";
  why: string;
}

/** The refusal of the first guard that stops this deploy, or undefined when it may start. */
export function deployRefusal(f: DeployFacts): DeployRefusal | undefined {
  if (f.tip === undefined)
    return { kind: "unreadable", why: "majhi could not read the project's base branch." };
  if (f.commit !== f.tip) {
    return {
      kind: "moved",
      why: `The base branch is at ${f.tip.slice(0, 7)} now, not at ${f.commit.slice(0, 7)}. Only the head of the base branch is deployed.`,
    };
  }
  if (!f.landed && f.checksConfigured && !(f.actor === "owner" && f.confirmUnchecked)) {
    return {
      kind: "unverified",
      why: `${f.commit.slice(0, 7)} was not merged by a task whose checks passed, so it has not been verified.`,
    };
  }
  const waiting = f.before.find((b) => !b.live);
  if (waiting !== undefined) {
    return { kind: "previous", why: `${waiting.env} is not live at ${f.commit.slice(0, 7)} yet.` };
  }
  if (f.actor === "captain" && f.rest !== undefined) {
    return { kind: "rest", why: `The captain rests: ${f.rest}` };
  }
  return undefined;
}

/** Whether the deploy goes out past the verification check: the owner chose it, for a commit no merge produced. */
export function deployIsUnchecked(
  f: Pick<DeployFacts, "landed" | "checksConfigured" | "confirmUnchecked" | "actor">,
): boolean {
  return !f.landed && f.checksConfigured && f.actor === "owner" && f.confirmUnchecked;
}
