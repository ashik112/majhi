import { type Authority, type AutonomyOrg, type CaptainChore, DAILY_CHORE_CAPS } from "@majhi/shared";
import { localDay } from "../usage/ranges.ts";

/**
 * The rules that always hold for the captain (SPEC 5.18), never shown as settings, and the caps that
 * keep it from running away. Pure.
 */

/** The hard caps of one run of a chore. A run stops at the first it reaches, with a line in the log. */
export const RUN_CAPS = { actions: 20, tokens: 60_000, minutes: 10 } as const;

/**
 * A chore whose run may take more actions than `RUN_CAPS.actions`: one memory run looks at every
 * waiting memory of its workspace, in chunks, without a model turn of the lane per memory.
 */
const RUN_ACTIONS: Partial<Record<CaptainChore, number>> = { memory: 100 };

/** The cap on actions in one run of the chore. */
export function runActions(chore: CaptainChore): number {
  return RUN_ACTIONS[chore] ?? RUN_CAPS.actions;
}

/** A workspace with this many memories its memory chore has not looked at runs the chore, not only daily. */
export const MEMORY_WAITING = 10;

/**
 * The daily caps per chore and workspace: `actions` counts what it did or handed to the owner,
 * `runs` counts runs. "Five ships, four memory runs": the daily one and up to three when memories pile up.
 */
export const DAILY_CAPS = DAILY_CHORE_CAPS;

/** A raise the owner gave for one day multiplies that day's caps of the chore. */
export const RAISE_FACTOR = 2;

/**
 * A chore's daily caps in a workspace on one day. The owner's own caps in Limits come first (`null`
 * there means no cap); without them, majhi's defaults. Ship has no default cap where the owner let the
 * captain decide merges: that row already says so, and the money budgets still hold it. `raised`: the
 * owner raised them for that day, which doubles what is capped.
 */
export function dailyCaps(
  chore: CaptainChore,
  raised: boolean,
  ws?: { rules?: Pick<AutonomyOrg, "chores"> | undefined; authority?: Pick<Authority, "merge"> | undefined },
): { actions?: number; runs?: number } {
  const own = ws?.rules?.chores?.[chore];
  const fallback: { actions?: number; runs?: number } =
    chore === "ship" && ws?.authority?.merge === "decide" ? {} : DAILY_CAPS[chore];
  const pick = (key: "actions" | "runs"): number | undefined => {
    const set = own?.[key];
    if (set === null) return undefined;
    return set ?? fallback[key];
  };
  const base = { actions: pick("actions"), runs: pick("runs") };
  const out: { actions?: number; runs?: number } = {};
  if (base.actions !== undefined) out.actions = raised ? base.actions * RAISE_FACTOR : base.actions;
  if (base.runs !== undefined) out.runs = raised ? base.runs * RAISE_FACTOR : base.runs;
  return out;
}

/** What reaching a cap means, per chore and cap: "answered its 20 questions". */
const REACHED: Record<CaptainChore, { actions?: (n: number) => string; runs?: (n: number) => string }> = {
  ship: { actions: (n) => `shipped its ${n} tasks` },
  cards: { actions: (n) => `answered its ${n} approval cards` },
  questions: { actions: (n) => `answered its ${n} questions` },
  memory: { runs: (n) => `did its ${n} memory runs` },
  projects: { runs: (n) => `did its ${n} project checks`, actions: (n) => `made its ${n} project changes` },
  triage: {
    runs: (n) => (n === 1 ? "did its triage run" : `did its ${n} triage runs`),
    actions: (n) => `triaged its ${n} tasks`,
  },
  cleanup: {
    runs: (n) => (n === 1 ? "did its cleanup run" : `did its ${n} cleanup runs`),
    actions: (n) => `cleaned up its ${n} items`,
  },
  stuck: { actions: (n) => `looked at its ${n} stuck tasks` },
  followups: {
    runs: (n) => (n === 1 ? "did its follow-ups run" : `did its ${n} follow-ups runs`),
    actions: (n) => `went through its ${n} follow-ups`,
  },
};

/** The question to the owner when a chore reached a daily cap in a workspace. */
export function capAskText(
  workspace: string,
  chore: CaptainChore,
  kind: "actions" | "runs",
  cap: number,
): string {
  const reached = REACHED[chore][kind]?.(cap) ?? `reached its daily cap of ${cap}`;
  return `${workspace}: the captain ${reached} for today. Raise the limit for today?`;
}

/** Two failures in a row turn a chore off for the workspace. */
export const FAILURES_OFF = 2;

/** Chores that run at a fixed time each day; the rest run when something happens. */
export const DAILY_CHORES: readonly CaptainChore[] = ["memory", "projects", "triage", "cleanup", "followups"];

/**
 * Why the captain rests in this workspace right now: outside its working hours or on a freeze date,
 * both in the workspace's zone. Undefined: it may act.
 */
export function restWhy(rules: AutonomyOrg | undefined, now: Date, tz: string): string | undefined {
  if (rules === undefined) return undefined;
  const day = localDay(now, tz);
  const frozen = (rules.freeze ?? []).find((f) => f.from <= day && day <= f.to);
  if (frozen !== undefined) {
    return frozen.from === frozen.to
      ? `${day} is a freeze date`
      : `${frozen.from} to ${frozen.to} is a freeze`;
  }
  if (rules.hours !== undefined && !withinHours(rules.hours, clockAt(now, tz))) {
    return `outside working hours (${rules.hours.from} to ${rules.hours.to})`;
  }
  return undefined;
}

/** `HH:MM` now in the zone. */
export function clockAt(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

/** Whether `clock` is in `[from, to)`, with hours that may run over midnight. */
export function withinHours(hours: { from: string; to: string }, clock: string): boolean {
  return hours.from < hours.to
    ? clock >= hours.from && clock < hours.to
    : clock >= hours.from || clock < hours.to;
}

/** Why the owner typing keeps the captain out of a task, or undefined. One line, the same everywhere. */
export function typingWhy(task: string, typing: boolean): string | undefined {
  return typing ? `waiting: you are typing in ${task}` : undefined;
}

/** Whether a branch is one the workspace lets the captain ship to. No list: each project's own base. */
export function branchAllowed(rules: AutonomyOrg | undefined, branch: string, base: string): boolean {
  const list = rules?.branches;
  return list === undefined ? branch === base : list.includes(branch);
}

/** Whether an AI tool is allowed in the workspace. No list: every tool. */
export function providerAllowed(rules: AutonomyOrg | undefined, tool: string): boolean {
  return rules?.providers === undefined || rules.providers.includes(tool);
}
