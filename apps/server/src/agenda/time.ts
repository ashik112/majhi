import { defaultTimeZone, localDay } from "../usage/ranges.ts";

/** Wall-clock time in a named zone, which `Date` does not give. */

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

/** The zone of the owner's day: the settings' zone when it is a real one, else the server's. */
export function ownerZone(tz: string | undefined): string {
  if (tz !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      // Not an IANA name: the server's zone.
    }
  }
  return defaultTimeZone();
}

/**
 * When the brief of a local day is due: `HH:MM` wall-clock time on that day in the zone. On a day the clocks
 * change it is still that wall-clock time (08:00 after the change is 08:00, not eight hours after midnight).
 * A time the change skips lands just after the gap.
 */
export function briefDue(day: string, clock: string, tz: string): Date {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const [h = 0, mi = 0] = clock.split(":").map(Number);
  const at = zonedToUtc({ y, m, d, h, mi, s: 0 }, tz);
  // A wall-clock time the change skips comes back an hour early: move it to just after the gap.
  const seen = wallIn(at, tz);
  return seen.h === h && seen.mi === mi ? at : new Date(at.getTime() + 3_600_000);
}

/** Whole calendar days from one local day to another (negative when the second is earlier). */
export function daysBetween(from: string, to: string): number {
  const ms = (day: string) => {
    const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** "today 17:00", "tomorrow", "Thu 9 Oct" for a moment, in the owner's calendar. A day's last minute shows no time. */
export function whenWord(at: Date, now: Date, tz: string): string {
  const n = daysBetween(localDay(now, tz), localDay(at, tz));
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  const timed = clock === "23:59" ? "" : ` ${clock}`;
  if (n === 0) return `today${timed}`;
  if (n === 1) return `tomorrow${timed}`;
  if (n === -1) return `yesterday${timed}`;
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(at);
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(at);
  return n > 0 && n < 7 ? `${weekday} ${date}${timed}` : `${date}${timed}`;
}

/** "3 min", "2 h", "1 day": how long something has waited. */
export function ageWord(fromIso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(fromIso).getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 2) return "just now";
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"}`;
}
