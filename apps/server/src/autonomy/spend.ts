import type {
  AccountView,
  AutonomyAccount,
  AutonomyHold,
  AutonomySettings,
  AutonomySpend,
  Budget,
  CapUse,
  Spend,
  UsageWindow,
} from "@majhi/shared";
import { budgetUse } from "../budgets/thresholds.ts";
import { addDays, dayStart, localDay } from "../usage/ranges.ts";

/**
 * Today's spend of autonomous mode against its caps, the account floors, and what holds new work
 * (PRV-74, rule 6). Pure: the repo sums the turns, the service reads the accounts.
 */

/** The owner's day that `now` falls in, in `tz`: `YYYY-MM-DD`, its start and its end (UTC ISO). */
export function dayWindow(now: Date, tz: string): { day: string; start: string; end: string } {
  const day = localDay(now, tz);
  return {
    day,
    start: dayStart(day, tz).toISOString(),
    end: dayStart(addDays(day, 1), tz).toISOString(),
  };
}

/** One org's autonomous turns today. `org` is `private` for tasks with no org. */
export interface OrgSpendRow {
  org: string;
  tokens: number;
  cost: number;
}

/** Use of one cap. Without a cap nothing is reached. */
export function capUse(used: Spend, cap: Budget | undefined): CapUse {
  if (cap === undefined) return { used, percent: 0, reached: false };
  const { percent } = budgetUse(used, cap);
  return { used, cap, percent, reached: percent >= 100 };
}

/** Sums of floats drift in the last digits; a millionth of a dollar is plenty. */
function money(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Today's spend: the total against the day cap, and every org with a cap or with spend today. */
export function spendOf(
  rows: readonly OrgSpendRow[],
  settings: Pick<AutonomySettings, "day" | "orgs">,
  window: { day: string; end: string },
  tz: string,
): AutonomySpend {
  const byOrg = new Map<string, Spend>();
  for (const r of rows) {
    const had = byOrg.get(r.org) ?? { tokens: 0, cost: 0 };
    byOrg.set(r.org, { tokens: had.tokens + r.tokens, cost: money(had.cost + r.cost) });
  }
  let tokens = 0;
  let cost = 0;
  for (const s of byOrg.values()) {
    tokens += s.tokens;
    cost += s.cost;
  }
  const capped = Object.entries(settings.orgs).flatMap(([id, o]) => (o.cap === undefined ? [] : [id]));
  const orgs = [...new Set([...capped, ...byOrg.keys()])].sort();
  return {
    day: window.day,
    tz,
    resetsAt: window.end,
    total: capUse({ tokens, cost: money(cost) }, settings.day),
    orgs: orgs.map((org) => ({
      org,
      ...capUse(byOrg.get(org) ?? { tokens: 0, cost: 0 }, settings.orgs[org]?.cap),
    })),
  };
}

/** "$5.00", "2M tokens", or both. */
export function capText(cap: Budget): string {
  const parts: string[] = [];
  if (cap.cost !== undefined) parts.push(`$${cap.cost.toFixed(2)}`);
  if (cap.tokens !== undefined) parts.push(`${tokenText(cap.tokens)} tokens`);
  return parts.join(" / ");
}

function tokenText(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(1))}k`;
  return String(n);
}

/** Percent left of a window that has not reset yet, or undefined when it says nothing. */
function left(w: UsageWindow | undefined, now: Date): number | undefined {
  if (w === undefined) return undefined;
  // A reset that already passed: the numbers are from before it, and the window is fresh.
  if (w.resetsAt !== undefined && Date.parse(w.resetsAt) <= now.getTime()) return undefined;
  return Math.max(0, 100 - w.usedPct);
}

/**
 * Each account with its windows, and why a floor keeps new work off it. With both windows under
 * their floors, the weekly one says it: it lasts longer.
 */
export function accountsOf(
  views: readonly Pick<AccountView, "id" | "org" | "tool" | "usage">[],
  floors: AutonomySettings["floors"],
  now: Date,
): AutonomyAccount[] {
  return views.map((v) => {
    const window = v.usage?.window;
    const weekly = v.usage?.weekly;
    const windowLeft = left(window, now);
    const weeklyLeft = left(weekly, now);
    let blocked: AutonomyAccount["blocked"];
    if (weeklyLeft !== undefined && weeklyLeft < floors.weekly) {
      blocked = {
        why: `${v.id} has ${Math.round(weeklyLeft)}% of its weekly window left, under the ${floors.weekly}% floor`,
        ...(weekly?.resetsAt === undefined ? {} : { until: weekly.resetsAt }),
      };
    } else if (windowLeft !== undefined && windowLeft < floors.window) {
      blocked = {
        why: `${v.id} has ${Math.round(windowLeft)}% of its 5-hour window left, under the ${floors.window}% floor`,
        ...(window?.resetsAt === undefined ? {} : { until: window.resetsAt }),
      };
    }
    return {
      id: v.id,
      org: v.org,
      tool: v.tool,
      ...(window === undefined ? {} : { window }),
      ...(weekly === undefined ? {} : { weekly }),
      ...(blocked === undefined ? {} : { blocked }),
    };
  });
}

/** What holds new work now: the day cap, org caps, and accounts under a floor. `names` are org names. */
export function holdsOf(
  spend: AutonomySpend,
  accounts: readonly AutonomyAccount[],
  names: Readonly<Record<string, string>> = {},
): AutonomyHold[] {
  const holds: AutonomyHold[] = [];
  if (spend.total.reached && spend.total.cap !== undefined) {
    holds.push({
      kind: "day-cap",
      text: `Autonomous mode reached its ${capText(spend.total.cap)} cap for today`,
      until: spend.resetsAt,
    });
  }
  for (const o of spend.orgs) {
    if (!o.reached || o.cap === undefined) continue;
    holds.push({
      kind: "org-cap",
      id: o.org,
      text: `${names[o.org] ?? o.org} reached its ${capText(o.cap)} cap for today`,
      until: spend.resetsAt,
    });
  }
  for (const a of accounts) {
    if (a.blocked === undefined) continue;
    holds.push({
      kind: "account",
      id: a.id,
      text: a.blocked.why,
      ...(a.blocked.until === undefined ? {} : { until: a.blocked.until }),
    });
  }
  return holds;
}

/** One key per hold, to see which started and which lifted. */
export function holdKey(h: Pick<AutonomyHold, "kind" | "id">): string {
  return `${h.kind}:${h.id ?? ""}`;
}

export function diffHolds(
  before: readonly AutonomyHold[],
  after: readonly AutonomyHold[],
): { started: AutonomyHold[]; lifted: AutonomyHold[] } {
  const had = new Set(before.map(holdKey));
  const has = new Set(after.map(holdKey));
  return {
    started: after.filter((h) => !had.has(holdKey(h))),
    lifted: before.filter((h) => !has.has(holdKey(h))),
  };
}

/** The cap that holds the work of `org` today: the day cap first, else the org's own. */
export function capHoldFor(holds: readonly AutonomyHold[], org: string): AutonomyHold | undefined {
  return holds.find((h) => h.kind === "day-cap") ?? holds.find((h) => h.kind === "org-cap" && h.id === org);
}

/** What a cap hold covers, as the run gate records it: `day`, or the org. */
export function capScope(hold: AutonomyHold): string {
  return hold.kind === "day-cap" ? "day" : (hold.id ?? "day");
}

/** The hold that keeps new work of `org` on these accounts from starting, if any. */
export function holdCovering(
  holds: readonly AutonomyHold[],
  org: string,
  accounts: readonly string[],
): AutonomyHold | undefined {
  return (
    capHoldFor(holds, org) ??
    holds.find((h) => h.kind === "account" && h.id !== undefined && accounts.includes(h.id))
  );
}
