import {
  type AutonomyHold,
  type AutonomySettings,
  type AutonomySpend,
  type Budget,
  type BudgetAsk,
  PRIVATE,
} from "@majhi/shared";
import { tokenText } from "./spend.ts";

/**
 * Budget questions (SPEC 5.18, brief section 3): when the autonomous budget or a workspace budget
 * runs out while work waits, the owner is asked once per budget and day whether to raise it for that
 * day. A raise is a dated override: it changes what holds today and never the saved setting. Pure.
 */

/** The scope the autonomous budget goes by, next to the workspace ids. */
export const DAY_SCOPE = "day";

/** "$20", "$20.50", "2M tokens", or both. Whole dollars drop the cents. */
export function budgetWord(b: Budget): string {
  const parts: string[] = [];
  if (b.cost !== undefined) parts.push(Number.isInteger(b.cost) ? `$${b.cost}` : `$${b.cost.toFixed(2)}`);
  if (b.tokens !== undefined) parts.push(`${tokenText(b.tokens)} tokens`);
  return parts.join(" / ");
}

/** What a raise gives: twice each part of the budget. */
export function doubled(b: Budget): Budget {
  return {
    ...(b.tokens === undefined ? {} : { tokens: b.tokens * 2 }),
    ...(b.cost === undefined ? {} : { cost: Math.round(b.cost * 2 * 100) / 100 }),
  };
}

/** The larger of two budgets, part by part: a raise never lowers a budget the owner set higher later. */
function larger(a: Budget, b: Budget): Budget {
  const tokens = Math.max(a.tokens ?? 0, b.tokens ?? 0);
  const cost = Math.max(a.cost ?? 0, b.cost ?? 0);
  return {
    ...(a.tokens === undefined && b.tokens === undefined ? {} : { tokens }),
    ...(a.cost === undefined && b.cost === undefined ? {} : { cost }),
  };
}

/**
 * The settings as they hold today: each raised budget replaces the saved one while it is larger.
 * `raised` is today's raises by scope (`day` or a workspace id), read for today's date only, so a raise
 * ends with its day. A workspace without a budget of its own shares the autonomous one, so a raise of
 * it never gives it one.
 */
export function withRaises(
  settings: AutonomySettings,
  raised: Readonly<Record<string, Budget>>,
): AutonomySettings {
  if (Object.keys(raised).length === 0) return settings;
  const orgs = { ...settings.orgs };
  for (const [org, rules] of Object.entries(settings.orgs)) {
    const today = raised[org];
    if (rules.cap !== undefined && today !== undefined)
      orgs[org] = { ...rules, cap: larger(rules.cap, today) };
  }
  const day = raised[DAY_SCOPE];
  return { ...settings, orgs, day: day === undefined ? settings.day : larger(settings.day, day) };
}

/** "Hooli used its $20 for today. 3 tasks are waiting. Raise it to $40 for today?" */
export function askText(name: string, cap: Budget, raiseTo: Budget, waiting: number): string {
  const tasks = waiting === 1 ? "1 task is waiting" : `${waiting} tasks are waiting`;
  return `${name} used its ${budgetWord(cap)} for today. ${tasks}. Raise it to ${budgetWord(raiseTo)} for today?`;
}

/** What the question is about: "Auto-pilot work" for the autonomous budget, else the workspace's name. */
export function askName(scope: string, names: Readonly<Record<string, string>>): string {
  if (scope === DAY_SCOPE) return "Auto-pilot work";
  return names[scope] ?? (scope === PRIVATE ? "Private" : scope);
}

/**
 * The line on a held task's card: "Waiting for Hooli's daily budget, $20 used". `used` is what the
 * budget's scope spent today.
 */
export function waitText(scope: string, name: string, used: number): string {
  const whose = scope === DAY_SCOPE ? "the Auto-pilot daily budget" : `${name}'s daily budget`;
  return `Waiting for ${whose}, ${budgetWord({ cost: Math.round(used * 100) / 100 })} used`;
}

/**
 * The budget holds that deserve a question: the autonomous budget when it ran out, else each
 * workspace budget that did. While the autonomous budget holds everything, a workspace question
 * would change nothing, so it is not asked.
 */
export function askableHolds(holds: readonly AutonomyHold[]): AutonomyHold[] {
  const day = holds.filter((h) => h.kind === "day-cap");
  return day.length > 0 ? day : holds.filter((h) => h.kind === "org-cap");
}

/** The ask for a budget that ran out, or undefined when no budget stands behind it or nothing waits. */
export function buildAsk(input: {
  scope: string;
  name: string;
  spend: AutonomySpend;
  waiting: number;
  day: string;
  at: string;
}): BudgetAsk | undefined {
  const cap =
    input.scope === DAY_SCOPE
      ? input.spend.total.cap
      : input.spend.orgs.find((o) => o.org === input.scope)?.cap;
  if (cap === undefined || input.waiting === 0) return undefined;
  const raiseTo = doubled(cap);
  return {
    scope: input.scope,
    name: input.name,
    day: input.day,
    cap,
    raiseTo,
    waiting: input.waiting,
    text: askText(input.name, cap, raiseTo, input.waiting),
    at: input.at,
  };
}
