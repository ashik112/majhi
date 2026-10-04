import { moneyWord } from "@majhi/shared";
import { addDays, dayStart, localDay } from "../usage/ranges.ts";

/** The monthly ceiling's arithmetic, pure. A month is the owner's calendar month in their time zone. */

export interface MonthWindow {
  /** `YYYY-MM`. */
  month: string;
  from: string;
  to: string;
  daysInMonth: number;
  /** Milliseconds from the start of the month to now, at least 0 and at most the month. */
  elapsedMs: number;
  totalMs: number;
}

function nextMonth(month: string): string {
  const [y = 0, m = 1] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function monthWindow(now: Date, tz: string): MonthWindow {
  const month = localDay(now, tz).slice(0, 7);
  const start = dayStart(`${month}-01`, tz);
  const end = dayStart(`${nextMonth(month)}-01`, tz);
  const total = end.getTime() - start.getTime();
  const last = addDays(`${nextMonth(month)}-01`, -1);
  return {
    month,
    from: start.toISOString(),
    to: end.toISOString(),
    daysInMonth: Number(last.slice(8, 10)),
    elapsedMs: Math.min(total, Math.max(0, now.getTime() - start.getTime())),
    totalMs: total,
  };
}

/** Where the month ends at the pace so far. Nothing in the first day: one morning says too little. */
export function projectedSpend(spent: number, w: MonthWindow): number | undefined {
  if (w.elapsedMs < 24 * 3_600_000) return undefined;
  return Math.round(((spent * w.totalMs) / w.elapsedMs) * 100) / 100;
}

/** "$212.00 of $500.00 this month, on pace for $410.00", with what is known. */
export function monthLine(spent: number, ceiling: number | undefined, projected: number | undefined): string {
  const head =
    ceiling === undefined
      ? `${moneyWord(spent)} this month`
      : `${moneyWord(spent)} of ${moneyWord(ceiling)} this month`;
  if (ceiling !== undefined && spent >= ceiling) return `${head}, new starts held`;
  return projected === undefined ? head : `${head}, on pace for ${moneyWord(projected)}`;
}

/** A raise for the month: a quarter more than the ceiling, to whole tens of dollars. */
export function raisedCeiling(ceiling: number): number {
  return Math.ceil((ceiling * 1.25) / 10) * 10;
}
