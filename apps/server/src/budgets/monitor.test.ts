import type { BudgetsSettings } from "@majhi/shared";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../store/migrations.ts";
import { UsageRepo } from "../usage/repo.ts";
import { BudgetMonitor, type FiredAlert } from "./monitor.ts";
import { BudgetAlertRepo } from "./repo.ts";

let db: Database.Database;
let usage: UsageRepo;
let budgets: BudgetsSettings;
let now: Date;
let fired: FiredAlert[];
let limits: FiredAlert[];
let changes: number;
let monitor: BudgetMonitor;

/** One turn with the given input tokens (and a cost), in org acme on account claude-acme. */
function turn(
  tokens: number,
  opts: { at?: Date; org?: string | null; account?: string; cost?: number } = {},
) {
  usage.insert({
    at: (opts.at ?? now).toISOString(),
    task: "ACM-1",
    agent: "acme-builder",
    account: opts.account ?? "claude-acme",
    tool: "claude",
    auth: "login",
    org: opts.org === undefined ? "acme" : opts.org,
    project: null,
    runId: null,
    model: null,
    inputTokens: tokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 999_999,
    cacheWriteTokens: 0,
    costUsd: opts.cost ?? null,
    costSource: "none",
    estimated: false,
  });
}

const record = (org: string | null = "acme", account = "claude-acme") => monitor.afterTurn({ org, account });

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  usage = new UsageRepo(db);
  budgets = { orgs: { acme: { tokens: 1000 } }, accounts: {} };
  // Wednesday 30 September 2026.
  now = new Date("2026-09-30T10:00:00.000Z");
  fired = [];
  limits = [];
  changes = 0;
  monitor = new BudgetMonitor({
    usage,
    alerts: new BudgetAlertRepo(db),
    budgets: async () => budgets,
    announce: (a) => fired.push(a),
    onLimit: async (a) => {
      limits.push(a);
    },
    onChange: () => changes++,
    tz: "UTC",
    now: () => now,
  });
});

describe("the check after a turn", () => {
  it("fires 80 and then 100, each once, and runs the 100% action once", async () => {
    turn(800);
    await record();
    await record();
    expect(fired.map((a) => a.threshold)).toEqual([80]);
    turn(250);
    await record();
    await record();
    expect(fired.map((a) => a.threshold)).toEqual([80, 100]);
    expect(limits.map((a) => a.threshold)).toEqual([100]);
    expect(fired[1]).toMatchObject({ scope: "org", id: "acme", task: "ACM-1", spend: { tokens: 1050 } });
    turn(500);
    await record();
    expect(fired).toHaveLength(2);
  });
});
