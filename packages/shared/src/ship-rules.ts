import { type AuthorityLevel, levelAllows, type RiskContext, type RiskKind } from "./risk-kinds.ts";

/**
 * Who does each step of shipping a task, from the workspace's one authority level (docs/briefs/workflow-reset.md,
 * step 1b). There are no per-task rules: the level and the two incident switches are the policy, so the
 * answer is the risk table read for the five kinds shipping touches.
 */

/** The steps of shipping. */
export const SHIP_STEPS = ["merge", "deployStaging", "deployProduction", "tell"] as const;
export type ShipStep = (typeof SHIP_STEPS)[number];

/** Who does one step: the captain, or the owner (a step the owner leaves to themselves waits for them). */
export type Who = "captain" | "owner";

/** Who does each step of shipping one task. */
export interface ShipSteps {
  merge: Who;
  push: Who;
  deployStaging: Who;
  deployProduction: Who;
  tell: Who;
}

const STEP_KIND: Record<keyof ShipSteps, RiskKind> = {
  merge: "merge-main",
  push: "push-branch",
  deployStaging: "deploy-staging",
  deployProduction: "deploy-production",
  tell: "client-message",
};

/**
 * Who does each step, for a task. `captainActs` is the answer of `mayWork` for this task's job: when the
 * captain may not act at all (Stop everything, or a backlog task while Autonomous is off) every step is the
 * owner's, whatever the level says. `ctx.incidentFix` is true for an incident's own fix, which the
 * workspace's "Captain ships" switch covers.
 */
export function shipSteps(level: AuthorityLevel, ctx: RiskContext, captainActs: boolean): ShipSteps {
  const who = (step: keyof ShipSteps): Who =>
    captainActs && levelAllows(level, STEP_KIND[step], ctx) ? "captain" : "owner";
  return {
    merge: who("merge"),
    push: who("push"),
    deployStaging: who("deployStaging"),
    deployProduction: who("deployProduction"),
    tell: who("tell"),
  };
}

/** The guards no level can switch off, as the sheet lists them. The code that does each step enforces them. */
export const SHIP_GUARDS: readonly string[] = [
  "Green checks on the exact head",
  "Secret scan",
  "Protected repos and paths",
  "Hours and freezes",
  "Not while you type",
  "Once per state of the work",
  "Re-check before a push",
];

/** The step a hold of the owner names on the trail and the board: "Merge", "Deploy production". */
export const SHIP_STEP_LABEL: Record<ShipStep | "push", string> = {
  merge: "Merge",
  push: "Push",
  deployStaging: "Deploy staging",
  deployProduction: "Deploy production",
  tell: "Client replies",
};
