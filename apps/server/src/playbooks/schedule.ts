import { type Cadence, onceInstant, type QuietHours } from "@majhi/shared";
import { clockAt, withinHours } from "../captain/rules.ts";
import { addDays, localDay } from "../usage/ranges.ts";

/**
 * When a playbook is due. Pure and clock-safe: a day is the workspace's local day, a daily slot is
 * the wall-clock time in its zone (the hour a clock change skips runs just after it, the hour that
 * repeats runs once), a run missed while majhi was off is one catch-up run and not a backlog, and a
 * clock set back never fires a playbook twice.
 */

const MINUTE = 60_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

/** The latest scheduled instant at or before `now`, or undefined for a cadence with no clock. */
export function latestSlot(cadence: Cadence, now: Date, tz: string): Date | undefined {
  if (cadence.kind !== "daily" && cadence.kind !== "weekly") return undefined;
  const today = localDay(now, tz);
  for (let back = 0; back <= 8; back++) {
    const day = addDays(today, -back);
    if (cadence.kind === "weekly" && weekdayOf(day) !== cadence.day) continue;
    const slot = onceInstant(`${day}T${cadence.at}`, tz);
    if (slot !== undefined && slot.getTime() <= now.getTime()) return slot;
  }
  return undefined;
}

/**
 * Whether the cadence is due: `last` is when it last started. Events and on-demand cadences are never
 * due on a clock. A `last` in the future (the clock went back) counts as now, so the playbook waits
 * its interval from here and does not fire again at once.
 */
export function isDue(cadence: Cadence, last: Date | undefined, now: Date, tz: string): boolean {
  switch (cadence.kind) {
    case "manual":
    case "events":
      return false;
    case "every": {
      if (last === undefined) return true;
      const seen = Math.min(last.getTime(), now.getTime());
      return now.getTime() - seen >= cadence.minutes * MINUTE;
    }
    case "daily":
    case "weekly": {
      const slot = latestSlot(cadence, now, tz);
      if (slot === undefined) return false;
      return last === undefined || last.getTime() < slot.getTime();
    }
  }
}

/** The next time it is due, for display: now when it is due already, undefined when it has no clock. */
export function nextRun(cadence: Cadence, last: Date | undefined, now: Date, tz: string): Date | undefined {
  if (cadence.kind === "manual" || cadence.kind === "events") return undefined;
  if (isDue(cadence, last, now, tz)) return now;
  if (cadence.kind === "every") {
    const seen = Math.min(last?.getTime() ?? now.getTime(), now.getTime());
    return new Date(seen + cadence.minutes * MINUTE);
  }
  const today = localDay(now, tz);
  for (let ahead = 0; ahead <= 8; ahead++) {
    const day = addDays(today, ahead);
    if (cadence.kind === "weekly" && weekdayOf(day) !== cadence.day) continue;
    const slot = onceInstant(`${day}T${cadence.at}`, tz);
    if (slot !== undefined && slot.getTime() > now.getTime()) return slot;
  }
  return undefined;
}

/** Whether `now` is in the quiet hours, in the workspace's zone. They may wrap midnight. */
export function inQuiet(quiet: QuietHours | undefined, now: Date, tz: string): boolean {
  if (quiet === undefined || quiet.from === quiet.to) return false;
  return withinHours(quiet, clockAt(now, tz));
}

/** "Mon 14:00", for a line that names when something starts again. */
export function whenText(at: Date, tz: string): string {
  const day = localDay(at, tz);
  return `${WEEKDAYS[weekdayOf(day)]} ${clockAt(at, tz)}`;
}
