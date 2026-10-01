import { BUDGET_THRESHOLDS, type Budget, type BudgetThreshold } from "@majhi/shared";
import { addDays, dayStart, weekStart } from "../usage/ranges.ts";

/** What a week has used, in the two units a budget can be set in. */
export interface Spend {
  /** Input + output + cache write. Cache reads are left out, and reasoning is already in output. */
  tokens: number;
  /** Dollars, from the turns that have a cost. */
  cost: number;
}

export interface BudgetUse {
  /** 0 and up. Over 100 when the budget is exceeded. */
  percent: number;
  measure: "tokens" | "cost";
}

/** Tokens a budget counts in a `usage` totals row. */
export function budgetTokens(t: {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
}): number {
  return t.inputTokens + t.outputTokens + t.cacheWriteTokens;
}

/**
 * How far along a budget is. With both a token and a cost budget, the one further along counts, so
 * either one running out raises the alert.
 */
export function budgetUse(spend: Spend, budget: Budget): BudgetUse {
  const tokens = budget.tokens === undefined ? undefined : (spend.tokens / budget.tokens) * 100;
  const cost = budget.cost === undefined ? undefined : (spend.cost / budget.cost) * 100;
  if (tokens !== undefined && (cost === undefined || tokens >= cost))
    return { percent: tokens, measure: "tokens" };
  return { percent: cost ?? 0, measure: "cost" };
}

/** The thresholds a percent has reached, lowest first. */
export function reached(percent: number): BudgetThreshold[] {
  return BUDGET_THRESHOLDS.filter((t) => percent >= t);
}

export interface AlertPlan {
  /** Fired before and no longer reached (the budget was raised): armed again. */
  rearm: BudgetThreshold[];
  /** Reached for the first time this week. Recorded all, but only the highest is announced. */
  fire: BudgetThreshold[];
  /** The one to say out loud: the highest of `fire`. */
  announce: BudgetThreshold | undefined;
}

/**
 * What to do about the alerts of one budget this week, given the thresholds already fired:
 * - a fired threshold the percent is now under comes back (a raised budget re-arms only the
 *   thresholds that are now under it);
 * - a threshold reached and not fired fires. A turn that jumps past 80 and 100 at once fires both,
 *   and says only the 100, so the 80 does not come late.
 */
export function planAlerts(percent: number, fired: readonly BudgetThreshold[]): AlertPlan {
  const now = reached(percent);
  const rearm = fired.filter((t) => !now.includes(t));
  const fire = now.filter((t) => !fired.includes(t));
  return { rearm, fire, announce: fire.at(-1) };
}

export interface WeekWindow {
  /** Monday, `YYYY-MM-DD`. */
  weekStart: string;
  /** UTC ISO times: the week starts at `start` and the next one at `end`. */
  start: string;
  end: string;
}

/** The week a local day is in, from Monday in the owner's time zone. Its `weekStart` keys the alerts. */
export function weekWindow(today: string, tz: string): WeekWindow {
  const monday = weekStart(today);
  return {
    weekStart: monday,
    start: dayStart(monday, tz).toISOString(),
    end: dayStart(addDays(monday, 7), tz).toISOString(),
  };
}
