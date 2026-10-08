import type { UsageRange } from "@majhi/shared";

/**
 * Local days in a time zone, and the UTC instants they start at. Turns are stored with a UTC ISO
 * time; "today", "this week" (from Monday) and "this month" are the owner's, so every range is
 * computed in their zone.
 */

const dayFormats = new Map<string, Intl.DateTimeFormat>();
const partFormats = new Map<string, Intl.DateTimeFormat>();

function dayFormat(tz: string): Intl.DateTimeFormat {
  let f = dayFormats.get(tz);
  if (f === undefined) {
    // en-CA formats dates as YYYY-MM-DD.
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(tz, f);
  }
  return f;
}

/** The local day of an instant, `YYYY-MM-DD`. */
export function localDay(at: Date | string, tz: string): string {
  return dayFormat(tz).format(typeof at === "string" ? new Date(at) : at);
}

/** Milliseconds the zone is ahead of UTC at this instant. */
function offsetMs(at: Date, tz: string): number {
  let f = partFormats.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partFormats.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(at)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const asUtc = Date.UTC(
    p.year ?? 0,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  );
  return asUtc - (at.getTime() - at.getMilliseconds());
}

function parts(day: string): [number, number, number] {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return [y, m, d];
}

/** The UTC instant local midnight of `day` falls on. Checked twice, so a DST change that day is right. */
export function dayStart(day: string, tz: string): Date {
  const [y, m, d] = parts(day);
  const guess = Date.UTC(y, m - 1, d);
  let at = new Date(guess - offsetMs(new Date(guess), tz));
  at = new Date(guess - offsetMs(at, tz));
  return at;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Monday of the week `day` is in. */
export function weekStart(day: string): string {
  const [y, m, d] = parts(day);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sunday
  return addDays(day, -((weekday + 6) % 7));
}

export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** First and last day of a named range, both inclusive. `all` has no bounds. */
export function rangeDays(range: UsageRange, today: string): { from: string; to: string } | undefined {
  switch (range) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "week":
      return { from: weekStart(today), to: today };
    case "last-week": {
      const monday = weekStart(today);
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    }
    case "month":
      return { from: monthStart(today), to: today };
    case "last-month": {
      const first = monthStart(today);
      return { from: monthStart(addDays(first, -1)), to: addDays(first, -1) };
    }
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "all":
      return undefined;
  }
}

/** The UTC ISO times a span of local days covers: `start` inclusive, `end` exclusive. */
export function dayBounds(from: string, to: string, tz: string): { start: string; end: string } {
  return { start: dayStart(from, tz).toISOString(), end: dayStart(addDays(to, 1), tz).toISOString() };
}

/** The zone majhi uses when a caller names none: `TZ`, else the runtime's own. */
export function defaultTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const tz = env.TZ?.trim();
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      // Not an IANA name: fall through.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The settings' zone, or the server's when it has none or names no real zone. */
export function zoneOr(tz: string | undefined): string {
  return tz !== undefined && validZone(tz) ? tz : defaultTimeZone();
}
