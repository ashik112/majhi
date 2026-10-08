import { type AutonomyOrg, type CaptainChore, READ_ONLY_CHORES } from "@majhi/shared";
import { localDay } from "../usage/ranges.ts";

/**
 * The rules that always hold for the captain (SPEC 5.18), never shown as settings, and the caps that
 * keep it from running away. Pure.
 */

/**
 * The one bound of a chore pass (D9): it ends at the first of these, with a line in the log. There is
 * no cap on actions: every action is keyed by the state it acts on (G1), so a repeat does nothing.
 * The 45 minutes are from 4207cc99: one slow test suite ended a ship run at 10 minutes before the
 * next task was looked at. The policy table replaces this constant in a later step.
 */
export const PASS_BOUND = { minutes: 45, tokens: 60_000 } as const;

/**
 * The loop guard (D10): after this many captain answers to one task with no progress in between (a
 * new commit in its worktree or a change of its status), majhi pauses the task for the owner.
 */
export const LOOP_GUARD_ANSWERS = 3;

/** A workspace with this many memories its memory chore has not looked at runs the chore, not only daily. */
export const MEMORY_WAITING = 10;

/** Two failures in a row pause a chore for the rest of the workspace's day. It tries again the next day. */
export const FAILURES_PAUSE = 2;

/** Whether a chore that failed at `offAt` still waits: until the end of that day in the workspace's zone. */
export function pausedToday(offAt: string | undefined, now: Date, tz: string): boolean {
  return offAt !== undefined && localDay(new Date(offAt), tz) === localDay(now, tz);
}

/** Chores that run at a fixed time each day; the rest run when something happens. */
export const DAILY_CHORES: readonly CaptainChore[] = [
  "memory",
  "projects",
  "triage",
  "cleanup",
  "followups",
  "discover",
  "tidy",
  "health",
  "checklist",
  "wiki",
  "watches",
];

export { clockIn as clockAt, withinHours } from "@majhi/shared";

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

/**
 * Whether working hours and freezes hold this chore. Looking never waits (the chores that only file findings), and
 * shipping is held per task, by its own ship plan, which an incident's fix is exempt from.
 */
export function restHolds(chore: CaptainChore): boolean {
  return chore !== "ship" && !READ_ONLY_CHORES.has(chore);
}
