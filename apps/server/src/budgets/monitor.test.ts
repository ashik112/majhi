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
  it("stays quiet under 80%, ignoring cache reads", async () => {
    turn(790);
    await record();
    expect(fired).toEqual([]);
  });

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

  it("checks the org and the account on their own budgets", async () => {
    budgets = { orgs: {}, accounts: { "claude-acme": { cost: 10 } } };
    turn(1, { cost: 8.5 });
    await record();
    expect(fired).toMatchObject([{ scope: "account", id: "claude-acme", threshold: 80, measure: "cost" }]);
    turn(1, { account: "claude-other", cost: 50 });
    await record(null, "claude-other");
    expect(fired).toHaveLength(1);
  });

  it("counts only this week's turns, and a new week starts with no alerts fired", async () => {
    // Sunday of the week before, and Monday of this one.
    turn(900, { at: new Date("2026-09-27T23:00:00.000Z") });
    await record();
    expect(fired).toEqual([]);
    turn(850, { at: new Date("2026-09-28T00:00:00.000Z") });
    await record();
    expect(fired.map((a) => a.threshold)).toEqual([80]);
    now = new Date("2026-10-05T00:30:00.000Z");
    expect((await monitor.status()).rows[0]).toMatchObject({
      weekStart: "2026-10-05",
      percent: 0,
      alerts: [],
    });
    turn(900, { at: now });
    await record();
    expect(fired.map((a) => a.threshold)).toEqual([80, 80]);
  });

  it("fires both at once when a turn jumps past 100, and the 80 does not come late", async () => {
    turn(1200);
    await record();
    expect(fired.map((a) => a.threshold)).toEqual([100]);
    await record();
    expect(fired).toHaveLength(1);
    expect((await monitor.status()).rows[0]?.alerts.map((a) => a.threshold)).toEqual([80, 100]);
  });
});

describe("a changed budget", () => {
  it("re-arms only the thresholds it is now under", async () => {
    turn(1100);
    await record();
    expect(fired).toHaveLength(1);
    budgets = { orgs: { acme: { tokens: 1200 } }, accounts: {} }; // 91.7%
    await monitor.recheck();
    expect((await monitor.status()).rows[0]?.alerts.map((a) => a.threshold)).toEqual([80]);
    turn(150);
    await record(); // 104%
    expect(fired.map((a) => a.threshold)).toEqual([100, 100]);
    budgets = { orgs: { acme: { tokens: 5000 } }, accounts: {} }; // 25%
    await monitor.recheck();
    expect((await monitor.status()).rows[0]?.alerts).toEqual([]);
    turn(3000);
    await record();
    expect(fired.map((a) => a.threshold)).toEqual([100, 100, 80]);
  });

  it("fires at once when lowered under what is already used", async () => {
    turn(500);
    await record();
    budgets = { orgs: { acme: { tokens: 550 } }, accounts: {} };
    await monitor.recheck();
    expect(fired.map((a) => a.threshold)).toEqual([80]);
    expect(changes).toBeGreaterThan(0);
  });
});

describe("a budget with tokens and cost", () => {
  it("fires each threshold once, whichever unit crosses it first", async () => {
    budgets = { orgs: { acme: { tokens: 1000, cost: 10 } }, accounts: {} };
    turn(850, { cost: 1 }); // tokens 85%, cost 10%
    await record();
    expect(fired).toMatchObject([{ threshold: 80, measure: "tokens" }]);
    turn(1, { cost: 8.5 }); // cost 95%: 80 was already said by tokens
    await record();
    expect(fired.map((a) => a.threshold)).toEqual([80]);
    turn(1, { cost: 1 }); // cost 105%, tokens 85%: the cost crosses 100 first
    await record();
    expect(fired).toMatchObject([{ threshold: 80 }, { threshold: 100, measure: "cost" }]);
    turn(500, { cost: 0 }); // tokens now 135% too: 100 is not said again
    await record();
    expect(fired.map((a) => a.threshold)).toEqual([80, 100]);
    expect(limits).toHaveLength(1);
  });
});

describe("limitedFor", () => {
  const run = (org: string | null, account: string | undefined, task = "ACM-1") => ({ org, account, task });

  it("holds an org's tasks at 100%, and tasks of other orgs not at all", async () => {
    turn(900);
    await record();
    expect(await monitor.limitedFor(run("acme", "claude-acme"))).toBeUndefined();
    turn(100);
    await record();
    expect(await monitor.limitedFor(run("acme", "claude-acme"))).toContain("org acme");
    expect(await monitor.limitedFor(run("acme", "claude-acme-2", "ACM-2"))).toContain("org acme");
    expect(await monitor.limitedFor(run("globex", "codex-globex", "GLX-1"))).toBeUndefined();
    expect(await monitor.limitedFor(run(null, undefined, "LOCAL-1"))).toBeUndefined();
  });

  it("holds the runs on an account at 100%, and runs on other accounts of the same org not", async () => {
    budgets = { orgs: {}, accounts: { "claude-acme": { tokens: 1000 } } };
    turn(1000);
    await record();
    expect(await monitor.limitedFor(run("acme", "claude-acme"))).toContain("account claude-acme");
    expect(await monitor.limitedFor(run("acme", "claude-acme-2", "ACM-2"))).toBeUndefined();
  });

  it("lets go when the budget is raised above the use, or removed", async () => {
    turn(1000);
    await record();
    budgets = { orgs: { acme: { tokens: 1500 } }, accounts: {} };
    await monitor.recheck();
    expect(await monitor.limitedFor(run("acme", "claude-acme"))).toBeUndefined();
    budgets = { orgs: { acme: { tokens: 1000 } }, accounts: {} };
    await monitor.recheck();
    expect(await monitor.limitedFor(run("acme", "claude-acme"))).toBeDefined();
    budgets = { orgs: {}, accounts: {} };
    expect(await monitor.limitedFor(run("acme", "claude-acme"))).toBeUndefined();
  });

  it("lets go when the week turns over", async () => {
    turn(1000);
    await record();
    expect(await monitor.limitedFor(run("acme", "claude-acme"))).toBeDefined();
    now = new Date("2026-10-05T00:01:00.000Z"); // Monday
    expect(await monitor.limitedFor(run("acme", "claude-acme"))).toBeUndefined();
  });

  it("does not hold a task the owner resumed, until a new 100% alert", async () => {
    turn(1000);
    await record();
    now = new Date("2026-09-30T11:00:00.000Z");
    monitor.exempt("ACM-1");
    expect(await monitor.limitedFor(run("acme", "claude-acme"))).toBeUndefined();
    // The same task keeps working over the budget: no new alert, so no new pause.
    turn(500, { at: now });
    await record();
    expect(await monitor.limitedFor(run("acme", "claude-acme"))).toBeUndefined();
    // Another task of the org is still held.
    expect(await monitor.limitedFor(run("acme", "claude-acme-2", "ACM-2"))).toBeDefined();
    // The budget is raised above the use, then crossed again later: that crossing is new.
    budgets = { orgs: { acme: { tokens: 3000 } }, accounts: {} };
    await monitor.recheck();
    now = new Date("2026-09-30T12:00:00.000Z");
    turn(1600, { at: now });
    await record();
    expect(fired.at(-1)).toMatchObject({ threshold: 100 });
    expect(await monitor.limitedFor(run("acme", "claude-acme"))).toBeDefined();
  });

  it("lifts runs through the lift hook after a change", async () => {
    let lifts = 0;
    monitor = new BudgetMonitor({
      usage,
      alerts: new BudgetAlertRepo(db),
      budgets: async () => budgets,
      announce: () => undefined,
      onLimit: async () => undefined,
      lift: async () => {
        lifts++;
      },
      tz: "UTC",
      now: () => now,
    });
    await monitor.recheck();
    await monitor.lift();
    expect(lifts).toBe(2);
  });
});

describe("status", () => {
  it("gives used, budget, percent, week and reset time per budget", async () => {
    budgets = { orgs: { acme: { tokens: 1000 } }, accounts: { "claude-acme": { cost: 4 } } };
    turn(250, { cost: 1 });
    expect(await monitor.status()).toEqual({
      tz: "UTC",
      rows: [
        {
          scope: "org",
          id: "acme",
          budget: { tokens: 1000 },
          used: { tokens: 250, cost: 1 },
          percent: 25,
          measure: "tokens",
          weekStart: "2026-09-28",
          resetsAt: "2026-10-05T00:00:00.000Z",
          alerts: [],
          paused: false,
        },
        {
          scope: "account",
          id: "claude-acme",
          budget: { cost: 4 },
          used: { tokens: 250, cost: 1 },
          percent: 25,
          measure: "cost",
          weekStart: "2026-09-28",
          resetsAt: "2026-10-05T00:00:00.000Z",
          alerts: [],
          paused: false,
        },
      ],
    });
  });
});
