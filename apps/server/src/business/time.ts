import type { DeadlineState } from "@majhi/shared";
import { UserError } from "../errors.ts";

/** Wall-clock time in a named zone, the one thing a deadline needs that `Date` does not give. */

const DAY_MS = 86_400_000;

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** The wall-clock time a moment has in a zone. */
export function wallIn(date: Date, tz: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    h: get("hour") % 24,
    mi: get("minute"),
    s: get("second"),
  };
}

/** How far the zone is ahead of UTC at a moment, in ms. */
function offsetAt(date: Date, tz: string): number {
  const w = wallIn(date, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The moment a wall-clock time falls in a zone. A time that does not exist (the hour skipped when
 * the clocks go forward) lands just after the gap; one that exists twice (clocks go back) takes the first.
 */
export function zonedToUtc(w: Wall, tz: string): Date {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  const first = guess - offsetAt(new Date(guess), tz);
  // The offset at the first guess may be the other side of a change: look again at the result.
  return new Date(guess - offsetAt(new Date(first), tz));
}

export interface ParsedDue {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  allDay: boolean;
}

/** `2026-11-20` or `2026-11-20T17:00`, checked for a real date. */
export function parseDue(due: string): ParsedDue {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(due);
  if (m === null) throw new UserError("Use a due date like 2026-11-20 or 2026-11-20T17:00.");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = m[4] === undefined ? 23 : Number(m[4]);
  const mi = m[5] === undefined ? 59 : Number(m[5]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    h > 23 ||
    mi > 59
  ) {
    throw new UserError("That is not a real date or time.");
  }
  return { y, m: mo, d, h, mi, allDay: m[4] === undefined };
}

/** The moment a deadline falls due. An all-day deadline ends with the last second of its day. */
export function dueInstant(due: string, tz: string): Date {
  const p = parseDue(due);
  return zonedToUtc({ y: p.y, m: p.m, d: p.d, h: p.h, mi: p.mi, s: p.allDay ? 59 : 0 }, tz);
}

/** Whole calendar days from today (in the zone) to the due day. */
export function daysUntil(due: string, tz: string, now: Date): number {
  const p = parseDue(due);
  const t = wallIn(now, tz);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(t.y, t.m - 1, t.d)) / DAY_MS);
}

/** The reminder moments: 09:00 on each lead day, in the zone, never after the deadline itself. */
export function reminderInstants(due: string, tz: string, leadDays: readonly number[]): Date[] {
  const p = parseDue(due);
  const dueAt = dueInstant(due, tz);
  return [...new Set(leadDays)]
    .sort((a, b) => b - a)
    .map((n) => {
      const day = new Date(Date.UTC(p.y, p.m - 1, p.d) - n * DAY_MS);
      const at = zonedToUtc(
        { y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), h: 9, mi: 0, s: 0 },
        tz,
      );
      return at.getTime() > dueAt.getTime() ? dueAt : at;
    });
}

/** How near a deadline is, by its own zone's calendar. */
export function stateOf(due: string, tz: string, now: Date, open: boolean): DeadlineState {
  if (!open) return "closed";
  const days = daysUntil(due, tz, now);
  if (days < 0) return "overdue";
  if (days === 0) return now.getTime() > dueInstant(due, tz).getTime() ? "overdue" : "today";
  return days <= 7 ? "soon" : "later";
}

/** This machine's zone. */
export function machineZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
