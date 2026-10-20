import type { AutonomyOrg, AutonomyOrgPatch, Freeze } from "@majhi/shared";
import { parseDollars } from "@/features/usage/budget-model";

/** What the Captain rules of a workspace edit in one draft, as the form holds it. */
export interface RulesDraft {
  /** Dollars a day as typed. Empty: the workspace shares the Autonomous budget. */
  budget: string;
  tz: string;
  freeze: Freeze[];
  branches: string[];
  /** Empty: every provider. */
  providers: string[];
  /** Empty: the captain's own account. */
  account: string;
}

export function rulesDraft(rules: AutonomyOrg, budget: number | undefined): RulesDraft {
  return {
    budget: budget === undefined ? "" : String(budget),
    tz: rules.tz ?? "",
    freeze: [...(rules.freeze ?? [])],
    branches: [...(rules.branches ?? [])],
    providers: [...(rules.providers ?? [])],
    account: rules.account ?? "",
  };
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The `autonomy.configure` change for one workspace's rules, or undefined when nothing changed. */
export function rulesPatch(
  draft: RulesDraft,
  rules: AutonomyOrg,
  budget: number | undefined,
): AutonomyOrgPatch | undefined {
  const patch: AutonomyOrgPatch = {};
  const typed = draft.budget.trim();
  const amount = typed === "" ? undefined : parseDollars(typed);
  if (amount !== budget && !(typed !== "" && amount === undefined)) {
    patch.cap = amount === undefined ? null : { cost: amount };
  }
  const tz = draft.tz.trim();
  if (tz !== (rules.tz ?? "")) patch.tz = tz === "" ? null : tz;
  const freeze = (f: readonly Freeze[]) => f.map((x) => `${x.from}..${x.to}`);
  if (!same(freeze(draft.freeze), freeze(rules.freeze ?? [])))
    patch.freeze = draft.freeze.length === 0 ? null : draft.freeze;
  if (!same(draft.branches, rules.branches ?? []))
    patch.branches = draft.branches.length === 0 ? null : draft.branches;
  if (!same([...draft.providers].sort(), [...(rules.providers ?? [])].sort())) {
    patch.providers = draft.providers.length === 0 ? null : draft.providers;
  }
  if (draft.account !== (rules.account ?? "")) patch.account = draft.account === "" ? null : draft.account;
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/** Why the form cannot be saved, or undefined. */
export function rulesProblem(draft: RulesDraft): string | undefined {
  const typed = draft.budget.trim();
  if (typed !== "" && parseDollars(typed) === undefined) return "The daily budget is a number of dollars.";
  if (draft.freeze.some((f) => f.from > f.to)) return "A freeze ends before it starts.";
  return undefined;
}

/** A short date like "24 Dec". */
export function shortDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
