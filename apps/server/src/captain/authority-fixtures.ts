import {
  ALL_ASK,
  type Authority,
  type ShipFacts,
  type ShipRule,
  shipRuleSubject,
  shipSteps,
} from "@majhi/shared";
import type { ShipPlan } from "../ship/plan.ts";

/** The three old levels as rows, for tests that set a workspace through `autonomy.configure`. */
export const RUNS: Authority = {
  ...ALL_ASK,
  start: "decide",
  questions: "decide",
  approvals: "decide",
  upkeep: "decide",
};
export const TIDY: Authority = { ...RUNS, start: "ask" };
export const ASK: Authority = { ...ALL_ASK };

/** The ship decision for tests: the rows (and rules) as the workspace has them, for a task of known facts. */
export function planOf(
  authority: Authority,
  over: {
    rules?: readonly ShipRule[] | undefined;
    facts?: ShipFacts | undefined;
    way?: ShipPlan["way"] | undefined;
    autonomous?: boolean | undefined;
  } = {},
): ShipPlan {
  const facts = over.facts ?? { projects: ["api"] };
  const steps = shipSteps(authority, over.rules ?? [], facts, over.autonomous ?? true);
  const rule = (over.rules ?? []).find((r) => r.id === steps.rule);
  return {
    org: "acme",
    steps,
    way: over.way ?? "local",
    facts,
    ...(rule === undefined ? {} : { ruleSubject: shipRuleSubject(rule.when) }),
  };
}
