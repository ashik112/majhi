import type { AutonomyOrg, AutonomyOrgPatch, CaptainLevel, Freeze } from "@majhi/shared";

/** The three choices, in the words of the Captain page. */
export const LEVELS: readonly { value: CaptainLevel; label: string; help: string }[] = [
  { value: "ask", label: "Only when I ask", help: "Answers when you talk to it. Nothing else." },
  {
    value: "tidy",
    label: "Keeps things tidy",
    help: "Routine cards, memory, new repos and cleanup. Asks before shipping.",
  },
  {
    value: "runs",
    label: "Runs it",
    help: "Also picks tasks, runs them and ships them, within today's budget.",
  },
];

/** "$20" or "20.50" as dollars, or undefined when it is not a positive amount. */
export function parseDollars(text: string): number | undefined {
  const plain = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(plain)) return undefined;
  const n = Number(plain);
  return n > 0 && n <= 10_000 ? n : undefined;
}

/** What "More rules" edits, as the form holds it. */
export interface RulesDraft {
  hoursOn: boolean;
  from: string;
  to: string;
  tz: string;
  freeze: Freeze[];
  branches: string[];
  /** Empty: every provider. */
  providers: string[];
  /** Empty: the captain's own account. */
  account: string;
  merge: boolean;
  push: boolean;
}

export function rulesDraft(rules: AutonomyOrg): RulesDraft {
  return {
    hoursOn: rules.hours !== undefined,
    from: rules.hours?.from ?? "09:00",
    to: rules.hours?.to ?? "18:00",
    tz: rules.tz ?? "",
    freeze: [...(rules.freeze ?? [])],
    branches: [...(rules.branches ?? [])],
    providers: [...(rules.providers ?? [])],
    account: rules.account ?? "",
    merge: rules.merge,
    push: rules.push,
  };
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The `autonomy.configure` change for one workspace's "More rules", or undefined when nothing changed. */
export function rulesPatch(draft: RulesDraft, rules: AutonomyOrg): AutonomyOrgPatch | undefined {
  const patch: AutonomyOrgPatch = {};
  const hours = draft.hoursOn ? { from: draft.from, to: draft.to } : undefined;
  if (hours?.from !== rules.hours?.from || hours?.to !== rules.hours?.to) patch.hours = hours ?? null;
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
  if (draft.merge !== rules.merge) patch.merge = draft.merge;
  if (draft.push !== rules.push) patch.push = draft.push;
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/** Why the form cannot be saved, or undefined. */
export function rulesProblem(draft: RulesDraft): string | undefined {
  if (draft.hoursOn && draft.from === draft.to) return "Working hours need a start and an end.";
  if (draft.freeze.some((f) => f.from > f.to)) return "A freeze ends before it starts.";
  return undefined;
}

/** "Shipped 2, tidied 8 memories" with a capital first letter. */
export function upperFirst(text: string): string {
  return text === "" ? text : text[0]?.toUpperCase() + text.slice(1);
}

/** A short date like "24 Dec". */
export function shortDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
