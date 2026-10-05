import type {
  Authority,
  AuthorityRow,
  AutonomyMode,
  AutonomyOrg,
  AutonomyOrgPatch,
  Freeze,
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
  "own",
];

export const AUTHORITY_ROW_TEXT: Record<AuthorityRow, { label: string; hint: string; detail?: string }> = {
  start: { label: "Start work", hint: "Takes tasks from the backlog" },
  questions: { label: "Answer questions", hint: "When the brief or the code settles them" },
  approvals: { label: "Approvals", hint: "Routine cards your rules allow" },
  upkeep: { label: "Upkeep", hint: "Memory, cleanup, triage, follow-ups" },
  merge: { label: "Merge", hint: "Into the base branch, after checks pass" },
  push: { label: "Push", hint: "Branches and merge requests" },
  own: { label: "Own work", hint: "Routine requests of tasks it started", detail: OWN_WORK_LINE },
};

/** The two quick presets in a workspace's column menu. */
export const AUTHORITY_PRESETS: readonly { label: string; help: string; rows: Authority }[] = [
  {
    label: "Hands off",
    help: "Captain decides everything except pushing",
    rows: {
      start: "decide",
      questions: "decide",
      approvals: "decide",
      upkeep: "decide",
      merge: "decide",
      push: "ask",
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
