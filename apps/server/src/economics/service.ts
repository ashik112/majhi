import {
  DEFAULT_MINUTES,
  type Economics,
  type EconomicsRange,
  type EconomicsRow,
  hoursWord,
  moneyWord,
  PRIVATE,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { monthSpend } from "../outcomes/spend.ts";
import { flagsFor, monthBounds, valueFor, windows } from "./compute.ts";
import { agentMinutes, lastShipped, type OwnerActions, ownerActions, shippedTasks } from "./repo.ts";

/**
 * Client economics (SPEC 5.18, captain v2 step 11): per workspace, a period against the one before.
 * Code only, no model. The rates are the owner's (`money.set`); with none a workspace shows what it
 * spent and did, and no margin.
 */

export interface EconomicsDeps {
  db: Database.Database;
  now?: () => Date;
  /** The owner's time zone, for months. */
  tz: () => Promise<string>;
  /** The workspaces majhi knows. */
  orgs: () => Promise<string[]>;
  rates: () => Map<string, { retainerUsd?: number; hourlyUsd?: number }>;
  /** Owner minutes per kind of action, as the scorecard sets them. */
  minutes: () => Record<string, number>;
}

const DAY_MS = 86_400_000;

export const ESTIMATE =
  "Your time is estimated: each message you sent to a task, each approval and each ship you made, at the minutes set for them in the scorecard.";

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function ownerMinutesOf(a: OwnerActions | undefined, m: Record<string, number>): number {
  if (a === undefined) return 0;
  const q = m.questions ?? DEFAULT_MINUTES.questions ?? 3;
  const ship = m.merge ?? DEFAULT_MINUTES.merge ?? 5;
  const ok = m.approvals ?? DEFAULT_MINUTES.approvals ?? 1;
  return a.messages * q + a.ships * ship + a.approvals * ok;
}

export class EconomicsService {
  constructor(private readonly deps: EconomicsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async get(range: EconomicsRange, only?: string): Promise<Economics> {
    const now = this.now();
    const tz = await this.deps.tz();
    const w = windows(range, now, tz);
    const { db } = this.deps;
    const iso = now.toISOString();
    const rates = this.deps.rates();
    const minutes = this.deps.minutes();
    const month = monthBounds(now, tz);

    const shippedNow = new Map(shippedTasks(db, w.from, w.to).map((r) => [r.org, r.n]));
    const shippedBefore = new Map(shippedTasks(db, w.previousFrom, w.previousTo).map((r) => [r.org, r.n]));
    const agentNow = new Map(agentMinutes(db, w.from, w.to, iso).map((r) => [r.org, r.minutes]));
    const agentBefore = new Map(
      agentMinutes(db, w.previousFrom, w.previousTo, iso).map((r) => [r.org, r.minutes]),
    );
    const spentNow = monthSpend(db, w.from, w.to);
    const spentBefore = monthSpend(db, w.previousFrom, w.previousTo);
    const spentMonth = monthSpend(db, month.from, month.to);
    const recent = monthSpend(db, new Date(now.getTime() - 14 * DAY_MS).toISOString(), iso);
    const ownerNow = new Map(ownerActions(db, w.from, w.to).map((r) => [r.org, r]));
    const ownerBefore = new Map(ownerActions(db, w.previousFrom, w.previousTo).map((r) => [r.org, r]));
    const last = lastShipped(db);

    const names = new Set<string>();
    if (only !== undefined) names.add(only);
    else {
      for (const org of await this.deps.orgs()) names.add(org);
      for (const m of [shippedNow, shippedBefore, agentNow, agentBefore, ownerNow, ownerBefore, rates]) {
        for (const org of m.keys()) names.add(org);
      }
      for (const m of [spentNow, spentBefore]) for (const org of m.keys()) names.add(org);
    }

    const rows: EconomicsRow[] = [];
    for (const org of [...names].sort((a, b) =>
      a === PRIVATE ? 1 : b === PRIVATE ? -1 : a.localeCompare(b),
    )) {
      const rate = rates.get(org) ?? {};
      const spend = round2(spentNow.get(org)?.costUsd ?? 0);
      const spendBefore = round2(spentBefore.get(org)?.costUsd ?? 0);
      const shipped = { now: shippedNow.get(org) ?? 0, before: shippedBefore.get(org) ?? 0 };
      const mineNow = round1(ownerMinutesOf(ownerNow.get(org), minutes));
      const mineBefore = round1(ownerMinutesOf(ownerBefore.get(org), minutes));
      const value = valueFor(rate.retainerUsd, range);
      const ownerCost = rate.hourlyUsd === undefined ? undefined : round2((mineNow / 60) * rate.hourlyUsd);
      const margin = value === undefined ? undefined : round2(value - spend - (ownerCost ?? 0));
      const lastAt = last.get(org);
      rows.push({
        org,
        shipped,
        agentMinutes: {
          now: round1(agentNow.get(org) ?? 0),
          before: round1(agentBefore.get(org) ?? 0),
        },
        spentUsd: { now: spend, before: spendBefore },
        ownerMinutes: { now: mineNow, before: mineBefore },
        ...(rate.retainerUsd === undefined ? {} : { retainerUsd: rate.retainerUsd }),
        ...(rate.hourlyUsd === undefined ? {} : { hourlyUsd: rate.hourlyUsd }),
        ...(value === undefined ? {} : { valueUsd: value }),
        ...(ownerCost === undefined ? {} : { ownerCostUsd: ownerCost }),
        ...(margin === undefined ? {} : { marginUsd: margin }),
        ...(lastAt === undefined ? {} : { lastShippedAt: lastAt }),
        flags: flagsFor({
          shipped,
          spentUsd: { now: spend, before: spendBefore },
          lastShippedAt: lastAt,
          recentSpendUsd: recent.get(org)?.costUsd ?? 0,
          retainerUsd: rate.retainerUsd,
          monthSpendUsd: spentMonth.get(org)?.costUsd ?? 0,
          now,
        }),
      });
    }
    return {
      range,
      from: w.from,
      to: w.to,
      previousFrom: w.previousFrom,
      previousTo: w.previousTo,
      label: w.label,
      estimate: ESTIMATE,
      rows,
    };
  }
}

/** One line for a workspace: "4 shipped, 3.5 h of agent work, $12.40, your time 25 min". For findings and drafts. */
export function rowLine(row: EconomicsRow): string {
  const parts = [
    `${row.shipped.now} shipped`,
    `${hoursWord(row.agentMinutes.now)} of agent work`,
    moneyWord(row.spentUsd.now),
    `your time about ${hoursWord(row.ownerMinutes.now)}`,
  ];
  if (row.marginUsd !== undefined) parts.push(`${moneyWord(row.marginUsd)} left`);
  return parts.join(", ");
}
