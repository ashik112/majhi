import { PRIVATE } from "@majhi/shared";
import type Database from "better-sqlite3";

/**
 * What the captain and the work it started cost, read from the turns table (every agent turn writes
 * one) and the run tables. All spend counts: agent tokens, the captain's lanes and the playbook runs
 * that ride on them. Laya runs locally and costs nothing; a cloud fallback of the decision provider is
 * not priced per call yet, so it is not in these sums.
 */

export interface Spend {
  tokens: number;
  costUsd: number;
}

const TOKENS = "input_tokens + output_tokens + cache_write_tokens";

/** Everything spent in a span, by workspace (`private` for tasks with no org). */
export function monthSpend(db: Database.Database, from: string, to: string): Map<string, Spend> {
  const rows = db
    .prepare(
      `SELECT COALESCE(org, ?) AS org, COALESCE(SUM(${TOKENS}), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost
         FROM turns WHERE at >= ? AND at < ? GROUP BY COALESCE(org, ?)`,
    )
    .all(PRIVATE, from, to, PRIVATE) as { org: string; tokens: number; cost: number }[];
  return new Map(rows.map((r) => [r.org, { tokens: r.tokens, costUsd: r.cost }]));
}

/** What the captain's lane of a workspace spent in a span: its own turns. */
export function laneSpend(db: Database.Database, org: string, from: string, to: string): Spend {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(${TOKENS}), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost FROM turns
        WHERE at >= ? AND at < ? AND task IN (SELECT chat FROM captain_lanes WHERE org = ?)`,
    )
    .get(from, to, org) as { tokens: number; cost: number };
  return { tokens: row.tokens, costUsd: row.cost };
}

/** What the tasks the captain started spent in a span, in a workspace. */
export function startedSpend(db: Database.Database, org: string, from: string, to: string): Spend {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(${TOKENS}), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost FROM turns
        WHERE at >= ? AND at < ? AND COALESCE(org, ?) = ? AND task IN (SELECT task FROM autonomy_tasks)`,
    )
    .get(from, to, PRIVATE, org) as { tokens: number; cost: number };
  return { tokens: row.tokens, costUsd: row.cost };
}

/** Tokens the chore runs of a workspace used in a span, by chore. */
export function choreTokens(
  db: Database.Database,
  org: string,
  from: string,
  to: string,
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT chore, COALESCE(SUM(tokens), 0) AS tokens FROM captain_runs
        WHERE org = ? AND started_at >= ? AND started_at < ? GROUP BY chore`,
    )
    .all(org, from, to) as { chore: string; tokens: number }[];
  return new Map(rows.map((r) => [r.chore, r.tokens]));
}

/** Tokens the playbook runs of a workspace used in a span, by playbook. */
export function playbookTokens(
  db: Database.Database,
  org: string,
  from: string,
  to: string,
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT playbook, COALESCE(SUM(tokens), 0) AS tokens FROM playbook_runs
        WHERE org = ? AND started_at >= ? AND started_at < ? GROUP BY playbook`,
    )
    .all(org, from, to) as { playbook: string; tokens: number }[];
  return new Map(rows.map((r) => [r.playbook, r.tokens]));
}

/** Runs of a playbook in a workspace in a span. */
export function playbookRuns(
  db: Database.Database,
  org: string,
  playbook: string,
  from: string,
  to: string,
): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM playbook_runs WHERE org = ? AND playbook = ? AND started_at >= ? AND started_at < ?",
    )
    .get(org, playbook, from, to) as { n: number };
  return row.n;
}
