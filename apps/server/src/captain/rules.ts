import type { AutonomyOrg, CaptainChore } from "@majhi/shared";
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

/** A workspace with this many memories its memory chore has not looked at runs the chore, not only daily. */
export const MEMORY_WAITING = 10;

/** Two failures in a row turn a chore off for the workspace. */
export const FAILURES_OFF = 2;

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
];

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
