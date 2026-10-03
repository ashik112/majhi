import type { AutonomyOrg, CaptainChore } from "@majhi/shared";
import { localDay } from "../usage/ranges.ts";

/**
 * The rules that always hold for the captain (SPEC 5.18), never shown as settings, and the caps that
 * keep it from running away. Pure.
 */

/** The captain keeps out of a task the owner acted in during the last 10 minutes. */
export const PRESENCE_MS = 10 * 60_000;

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
export const DAILY_CAPS: Record<CaptainChore, { actions?: number; runs?: number }> = {
  ship: { actions: 5 },
  cards: { actions: 40 },
  questions: { actions: 20 },
  memory: { runs: 4 },
  projects: { runs: 3, actions: 10 },
  triage: { runs: 1, actions: 20 },
  cleanup: { runs: 1, actions: 20 },
  stuck: { actions: 10 },
};

/** Two failures in a row turn a chore off for the workspace. */
export const FAILURES_OFF = 2;

/** Chores that run at a fixed time each day; the rest run when something happens. */
export const DAILY_CHORES: readonly CaptainChore[] = ["memory", "projects", "triage", "cleanup"];

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

/** Why presence keeps the captain out of a task, or undefined. */
export function presenceWhy(ownerAt: string | undefined, now: Date): string | undefined {
  if (ownerAt === undefined) return undefined;
  const ago = now.getTime() - Date.parse(ownerAt);
  if (!(ago >= 0 && ago < PRESENCE_MS)) return undefined;
  const minutes = Math.max(1, Math.round(ago / 60_000));
  return `the owner acted in it ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
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
