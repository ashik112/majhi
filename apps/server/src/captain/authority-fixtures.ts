import { ALL_ASK, type Authority, authorityFromLevel, type ShipSteps } from "@majhi/shared";
import type { ShipPlan } from "../ship/plan.ts";

/** Test fixtures: the rows a workspace has at each level, and the ship plan that follows from rows. */

/** Ask me: the captain does upkeep and nothing else. */
export const ASK: Authority = authorityFromLevel("ask");
/** Routine: it works, answers and pushes the task's own branch; merging and deploying are the owner's. */
export const RUNS: Authority = authorityFromLevel("routine");
/** Full: Routine, and it also merges into main and deploys to staging. */
export const FULL: Authority = authorityFromLevel("full");
export { ALL_ASK };

/** The ship decision for tests: who does each step for rows as the workspace has them. */
export function planOf(
  authority: Authority,
  over: { way?: ShipPlan["way"] | undefined; autonomous?: boolean | undefined } = {},
): ShipPlan {
  const who = (choice: "decide" | "ask") =>
    over.autonomous !== false && choice === "decide" ? ("captain" as const) : ("owner" as const);
  const steps: ShipSteps = {
    merge: who(authority.merge),
    push: who(authority.push),
    deployStaging: who(authority.deployStaging),
    deployProduction: who(authority.deployProduction),
    tell: who(authority.tell),
  };
  return {
    org: "acme",
    steps,
    way: over.way ?? "local",
    facts: { projects: ["api"] },
  };
}
