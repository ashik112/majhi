import { type EconomicsFlag, type EconomicsRange, moneyWord } from "@majhi/shared";
import { addDays, dayStart, localDay } from "../usage/ranges.ts";

/**
 * The arithmetic of client economics, pure: windows, a retainer for a period, flags. Nothing reads the
 * database here and nothing is guessed: a figure that needs a rate the owner did not enter is absent.
 */

const DAY_MS = 86_400_000;

/** Spend must rise by this share, and by at least `MIN_RISE_USD`, before it is called growth. */
export const GROWTH_SHARE = 0.25;
export const MIN_RISE_USD = 5;
/** Spend this share of the retainer is near the budget. */
export const NEAR_BUDGET_SHARE = 0.8;
/** No shipped work for this long is quiet. */
export const QUIET_DAYS = 14;

export interface Windows {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  label: string;
}

function monthBefore(month: string): string {
  const [y = 0, m = 1] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * The period and the one before it, over the same stretch. A week is the last seven days against the
 * seven before. A month is the month so far against the same number of days of the month before, so a
 * half month is never set against a whole one.
 */
export function windows(range: EconomicsRange, now: Date, tz: string): Windows {
  if (range === "week") {
    const to = now.getTime();
    return {
      from: new Date(to - 7 * DAY_MS).toISOString(),
      to: new Date(to).toISOString(),
      previousFrom: new Date(to - 14 * DAY_MS).toISOString(),
      previousTo: new Date(to - 7 * DAY_MS).toISOString(),
      label: "Last 7 days",
    };
  }
  const month = localDay(now, tz).slice(0, 7);
  const start = dayStart(`${month}-01`, tz);
  const prevStart = dayStart(`${monthBefore(month)}-01`, tz);
  const elapsed = now.getTime() - start.getTime();
  // The month before may be shorter: its stretch ends where this month begins at the latest.
  const prevEnd = Math.min(prevStart.getTime() + elapsed, start.getTime());
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long" }).format(now);
  return {
    from: start.toISOString(),
    to: now.toISOString(),
    previousFrom: prevStart.toISOString(),
    previousTo: new Date(prevEnd).toISOString(),
    label: `${name} so far`,
  };
}

/** `2026-W41`: the ISO week of a moment, in UTC. A weekly finding or draft is deduplicated by it. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - first.getTime()) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The first and last instants of the calendar month `now` is in. */
export function monthBounds(now: Date, tz: string): { from: string; to: string } {
  const month = localDay(now, tz).slice(0, 7);
  const from = dayStart(`${month}-01`, tz);
  const next = addDays(`${month}-01`, 32).slice(0, 7);
  return { from: from.toISOString(), to: dayStart(`${next}-01`, tz).toISOString() };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** What the client pays for the period. A week is a twelfth-over-fifty-two share of the monthly retainer. */
export function valueFor(retainerUsd: number | undefined, range: EconomicsRange): number | undefined {
  if (retainerUsd === undefined) return undefined;
  return round2(range === "week" ? (retainerUsd * 12) / 52 : retainerUsd);
}

/** Growth of a count or an amount against the one before. Nothing before and something now counts as full growth. */
export function growth(before: number, now: number): number {
  if (before <= 0) return now > 0 ? 1 : 0;
  return (now - before) / before;
}

export interface FlagInput {
  shipped: { now: number; before: number };
  spentUsd: { now: number; before: number };
  /** When a task last shipped, any time. */
  lastShippedAt: string | undefined;
  /** Spend in the last `QUIET_DAYS` days. */
  recentSpendUsd: number;
  retainerUsd: number | undefined;
  /** Spend in the calendar month so far. */
  monthSpendUsd: number;
  now: Date;
}

/**
 * The three things worth the owner's eye. A workspace that never did anything has no flags: there is
 * nothing to watch yet.
 */
export function flagsFor(i: FlagInput): EconomicsFlag[] {
  const out: EconomicsFlag[] = [];
  const rise = i.spentUsd.now - i.spentUsd.before;
  const spendGrowth = growth(i.spentUsd.before, i.spentUsd.now);
  const workGrowth = growth(i.shipped.before, i.shipped.now);
  if (rise >= MIN_RISE_USD && spendGrowth >= GROWTH_SHARE && spendGrowth - workGrowth >= GROWTH_SHARE) {
    out.push({
      kind: "spend-outpaces-work",
      text: `Spend rose ${moneyWord(rise)} while shipped work went from ${i.shipped.before} to ${i.shipped.now}.`,
    });
  }
  const quietMs = i.now.getTime() - QUIET_DAYS * DAY_MS;
  const shippedAt = i.lastShippedAt === undefined ? undefined : Date.parse(i.lastShippedAt);
  const active = shippedAt !== undefined || i.recentSpendUsd > 0;
  if (active && (shippedAt === undefined || shippedAt < quietMs) && i.shipped.now === 0) {
    out.push({
      kind: "quiet",
      text:
        shippedAt === undefined
          ? `Nothing has shipped, and ${moneyWord(i.recentSpendUsd)} was spent in the last ${QUIET_DAYS} days.`
          : `Nothing has shipped in ${Math.floor((i.now.getTime() - shippedAt) / DAY_MS)} days.`,
    });
  }
  if (i.retainerUsd !== undefined && i.retainerUsd > 0 && i.monthSpendUsd >= i.retainerUsd * NEAR_BUDGET_SHARE) {
    const share = Math.round((i.monthSpendUsd / i.retainerUsd) * 100);
    out.push({
      kind: "near-budget",
      text: `${moneyWord(i.monthSpendUsd)} spent this month, ${share}% of the ${moneyWord(i.retainerUsd)} retainer.`,
    });
  }
  return out;
}
