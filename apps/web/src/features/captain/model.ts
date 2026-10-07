import type {
  Authority,
  AuthorityRow,
  AutonomyMode,
  AutonomyOrg,
  AutonomyOrgPatch,
  CaptainOrg,
  Freeze,
  ShipRule,
  ShipWhen,
} from "@majhi/shared";
import { OWN_WORK_LINE } from "@majhi/shared";

/** The rows of the delegation grid, in the order it shows them. */
export const AUTHORITY_ROWS_ORDER: readonly AuthorityRow[] = [
  "start",
  "questions",
  "approvals",
  "upkeep",
  "merge",
  "push",
  "deployStaging",
  "deployProduction",
  "tell",
  "own",
];

export const AUTHORITY_ROW_TEXT: Record<
  AuthorityRow,
  { label: string; hint: string; detail?: string; isNew?: true }
> = {
  start: { label: "Start work", hint: "Takes tasks from the backlog" },
  questions: { label: "Answer questions", hint: "When the brief or the code settles them" },
  approvals: { label: "Approvals", hint: "Routine cards your rules allow" },
  upkeep: { label: "Upkeep", hint: "Memory, cleanup, triage, follow-ups" },
  merge: { label: "Merge", hint: "Local merge, or the merge request on the host" },
  push: { label: "Push", hint: "Branches and merge requests" },
  deployStaging: {
    label: "Deploy staging",
    hint: "After a merge. Verified, rolled back if it fails",
    isNew: true,
  },
  deployProduction: { label: "Deploy production", hint: "Only by a rule you set", isNew: true },
  tell: { label: "Tell the client", hint: "Replies to a client chat", isNew: true },
  own: { label: "Own work", hint: "Routine requests of tasks it started", detail: OWN_WORK_LINE },
};

/** The two quick presets in a workspace's column menu. */
export const AUTHORITY_PRESETS: readonly { label: string; help: string; rows: Authority }[] = [
  {
    label: "Hands off",
    help: "Captain decides everything except pushing, deploying and talking to clients",
    rows: {
      start: "decide",
      questions: "decide",
      approvals: "decide",
      upkeep: "decide",
      merge: "decide",
      push: "ask",
      deployStaging: "ask",
      deployProduction: "ask",
      tell: "ask",
      own: "decide",
    },
  },
  {
    label: "Ask me first",
    help: "You decide everything except upkeep",
    rows: {
      start: "ask",
      questions: "ask",
      approvals: "ask",
      upkeep: "decide",
      merge: "ask",
      push: "ask",
      deployStaging: "ask",
      deployProduction: "ask",
      tell: "ask",
      own: "ask",
    },
  },
];

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

/**
 * The one sentence under the title that is true right now. Off: what still runs and what waits.
 * On: what runs and what is next. Both end with how many decisions need the owner.
 */
export function statusSentence(input: {
  mode: AutonomyMode;
  /** Whether any workspace lets the captain do upkeep, which keeps running while Off. */
  upkeep: boolean;
  running: number;
  next: number;
  decisions: number;
}): string {
  const waits =
    input.decisions === 0
      ? "Nothing needs you."
      : `${input.decisions} ${input.decisions === 1 ? "decision needs" : "decisions need"} you.`;
  switch (input.mode) {
    case "off":
      return `Off: it only answers when you ask${input.upkeep ? ", and keeps memory and cleanup going" : ""}. ${waits}`;
    case "stopping":
      return `Turning off: tasks finish their step, then pause. ${waits}`;
    default:
      return `On: ${input.running} running, ${input.next} next. ${waits}`;
  }
}

// ---------------------------------------------------------------------------
// Ship rules, "By type"

/** A new rule starts as the rows say, so adding one changes nothing until a cell is flipped. */
export function newShipRule(rows: Authority): ShipRule {
  return {
    id: crypto.randomUUID().replaceAll("-", "").slice(0, 8),
    when: { types: ["bug"], maxChangedLines: 100 },
    merge: rows.merge,
    deployStaging: rows.deployStaging,
    deployProduction: rows.deployProduction,
    tell: rows.tell,
  };
}

/** The list with the rule at `index` replaced. */
export function withRule(rules: readonly ShipRule[], index: number, next: ShipRule): ShipRule[] {
  return rules.map((rule, i) => (i === index ? next : rule));
}

/** The list with the rule at `index` moved by one place; the same list at either end. */
export function movedRule(rules: readonly ShipRule[], index: number, by: -1 | 1): ShipRule[] {
  const to = index + by;
  const rule = rules[index];
  if (rule === undefined || to < 0 || to >= rules.length) return [...rules];
  const next = [...rules];
  next.splice(index, 1);
  next.splice(to, 0, rule);
  return next;
}

/** A rule's `when` with one field changed; a list or limit left empty is removed. */
export function whenWith(when: ShipWhen, change: Partial<ShipWhen>): ShipWhen {
  const next: ShipWhen = { ...when, ...change };
  if (next.areas?.length === 0) delete next.areas;
  if (next.projects?.length === 0) delete next.projects;
  return next;
}

/** Whether any workspace row, or a rule of the workspace shown, lets the captain deploy production. */
export function productionByCaptain(orgs: readonly CaptainOrg[], shown: CaptainOrg | undefined): boolean {
  return (
    orgs.some((o) => o.authority.deployProduction === "decide") ||
    (shown?.rules.ships ?? []).some((rule) => rule.deployProduction === "decide")
  );
}
