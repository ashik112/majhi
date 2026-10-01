import { Cron } from "croner";
import type { ScheduleSpec } from "./automation.ts";

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

/** Five fields: minute, hour, day of month, month, day of week. Seconds and `@daily` are not accepted. */
export function cronProblem(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5)
    return "A cron expression has 5 fields: minute hour day-of-month month day-of-week";
  try {
    new Cron(fields.join(" "), { timezone: "UTC" });
    return undefined;
  } catch (err) {
    return `Not a valid cron expression: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Is this an IANA time zone name the runtime knows? */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC at `ms`, in milliseconds (positive east of Greenwich). */
function offsetAt(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const ABSOLUTE = /(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The instant a `once` time means. A time with `Z` or an offset is absolute. One without is the
 * wall clock in `tz`; in the hour a clock change skips, it runs just after the change.
 * Undefined when `at` is not a time.
 */
export function onceInstant(at: string, tz: string): Date | undefined {
  const text = at.trim();
  if (ABSOLUTE.test(text)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const m = LOCAL.exec(text);
  if (m === null) return undefined;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return undefined;
  const wall = Date.UTC(y, mo - 1, d, h, mi, sec);
  if (new Date(wall).getUTCMonth() !== mo - 1) return undefined;
  // The offsets either side of the day: one of them holds at `wall` unless a clock change skips it.
  const before = offsetAt(wall - 86_400_000, tz);
  const after = offsetAt(wall + 86_400_000, tz);
  const valid = [before, after].map((off) => wall - off).filter((t) => offsetAt(t, tz) === wall - t);
  // Twice on the clock (the hour that repeats): the first time. Never on the clock: just after the gap.
  return new Date(valid.length > 0 ? Math.min(...valid) : wall - before);
}

/**
 * The first run strictly after `after`, or undefined when there is none (a `once` time already
 * past, or a cron expression that never matches). Intervals count from `after`.
 */
export function nextRunAfter(spec: ScheduleSpec, timeZone: string, after: Date): Date | undefined {
  switch (spec.kind) {
    case "interval":
      return new Date(after.getTime() + spec.every * UNIT_MS[spec.unit]);
    case "cron":
      return (
        new Cron(spec.expression.trim().split(/\s+/).join(" "), { timezone: timeZone }).nextRun(after) ??
        undefined
      );
    case "once": {
      const at = onceInstant(spec.at, timeZone);
      return at !== undefined && at.getTime() > after.getTime() ? at : undefined;
    }
  }
}

/** The next `count` runs after `after`, for a preview. */
export function upcomingRuns(spec: ScheduleSpec, timeZone: string, after: Date, count: number): Date[] {
  const runs: Date[] = [];
  let from = after;
  while (runs.length < count) {
    const next = nextRunAfter(spec, timeZone, from);
    if (next === undefined) break;
    runs.push(next);
    from = next;
  }
  return runs;
}
