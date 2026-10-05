import { type AccountUsage, AutonomySettingsSchema, type Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { UsageRepo } from "../usage/repo.ts";
import { AutonomyRepo } from "./repo.ts";
import { accountsOf, capHoldFor, dayWindow, diffHolds, holdsOf, spendOf } from "./spend.ts";

describe("dayWindow", () => {
  it("is the owner's day in their zone, midnight to midnight", () => {
    const now = new Date("2026-10-01T23:30:00Z");
    expect(dayWindow(now, "Europe/Berlin")).toEqual({
      day: "2026-10-02",
      start: "2026-10-01T22:00:00.000Z",
      end: "2026-10-02T22:00:00.000Z",
    });
    expect(dayWindow(now, "America/New_York")).toEqual({
      day: "2026-10-01",
      start: "2026-10-01T04:00:00.000Z",
      end: "2026-10-02T04:00:00.000Z",
    });
  });
});

const settings = AutonomySettingsSchema.parse({
  day: { cost: 2 },
  orgs: { acme: { cap: { cost: 1 } }, globex: { cap: { tokens: 1000 } }, northwind: { push: true } },
});
const window = { day: "2026-10-01", end: "2026-10-02T00:00:00.000Z" };

describe("spendOf", () => {
  it("sums per org, lists every org with a cap or with spend, and takes the larger share", () => {
    const spend = spendOf(
      [
        { org: "acme", tokens: 100, cost: 1.5 },
        { org: "private", tokens: 50, cost: 0.25 },
        { org: "acme", tokens: 10, cost: 0.1 },
      ],
      settings,
      window,
      "UTC",
    );
    expect(spend.total).toEqual({
      used: { tokens: 160, cost: 1.85 },
      cap: { cost: 2 },
      percent: 92.5,
      reached: false,
    });
    expect(spend.orgs.map((o) => [o.org, o.used.cost, o.percent, o.reached])).toEqual([
      ["acme", 1.6, 160, true],
      ["globex", 0, 0, false],
      ["private", 0.25, 0, false],
    ]);
    expect(spend.resetsAt).toBe(window.end);
  });

  it("holds an org whose cap is reached, holds everything at the day cap, and lifts when the cap is raised", () => {
    const rows = [{ org: "acme", tokens: 100, cost: 1.2 }];
    const before = holdsOf(spendOf(rows, settings, window, "UTC"), [], { acme: "Acme" });
    expect(before).toEqual([
      { kind: "org-cap", id: "acme", text: "Acme reached its $1.00 cap for today", until: window.end },
    ]);
    expect(capHoldFor(before, "acme")?.kind).toBe("org-cap");
    expect(capHoldFor(before, "globex")).toBe(undefined);

    const raised = AutonomySettingsSchema.parse({ ...settings, orgs: { acme: { cap: { cost: 5 } } } });
    const after = holdsOf(spendOf(rows, raised, window, "UTC"), []);
    expect(diffHolds(before, after)).toEqual({ started: [], lifted: before });

    const day = holdsOf(spendOf([{ org: "globex", tokens: 10, cost: 2.5 }], raised, window, "UTC"), []);
    expect(day.map((h) => h.kind)).toEqual(["day-cap"]);
    expect(capHoldFor(day, "northwind")?.kind).toBe("day-cap");
  });
});

describe("accountsOf", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const floors = { window: 10, weekly: 5 };
  const view = (id: string, usage: Partial<Pick<AccountUsage, "window" | "weekly">>) => ({
    id,
    org: "acme",
    tool: "claude" as const,
    usage: { models: [], estimated: false, updatedAt: now.toISOString(), ...usage },
  });

  it("keeps new work off an account under a floor until its window resets", () => {
    const accounts = accountsOf(
      [
        view("low-window", { window: { usedPct: 95, resetsAt: "2026-10-01T14:00:00Z" } }),
        view("low-weekly", {
          window: { usedPct: 95, resetsAt: "2026-10-01T14:00:00Z" },
          weekly: { usedPct: 97, resetsAt: "2026-10-05T00:00:00Z" },
        }),
        view("reset-passed", { window: { usedPct: 99, resetsAt: "2026-10-01T11:00:00Z" } }),
        view("fine", { window: { usedPct: 50 }, weekly: { usedPct: 80 } }),
      ],
      floors,
      now,
    );
    expect(accounts.map((a) => [a.id, a.blocked?.until])).toEqual([
      ["low-window", "2026-10-01T14:00:00Z"],
      ["low-weekly", "2026-10-05T00:00:00Z"],
      ["reset-passed", undefined],
      ["fine", undefined],
    ]);
    expect(accounts[0]?.blocked?.why).toBe(
      "low-window has 5% of its 5-hour window left, under the 10% floor",
    );
    expect(accounts[1]?.blocked?.why).toContain("weekly window");
    expect(holdsOf(spendOf([], settings, window, "UTC"), accounts).map((h) => h.id)).toEqual([
      "low-window",
      "low-weekly",
    ]);
  });
});

function task(id: string, org?: string): Task {
  return {
    id,
    title: id,
    brief: id,
    kind: "code",
    ...(org === undefined ? {} : { org }),
    status: "running",
    folder: `/tmp/${id}`,
    repos: [],
    team: ["acme-builder"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as Task;
}

describe("AutonomyRepo.spendRows", () => {
  it("counts autonomous tasks from when they joined, and the autonomy chat, per org", () => {
    const store = new Store(":memory:");
    for (const t of [task("ACM-1", "acme"), task("ACM-2", "acme"), task("LOCAL-1"), task("LOCAL-2")]) {
      store.tasks.insert(t);
    }
    const turns = new UsageRepo(store.raw);
    const turn = (taskId: string, org: string | null, at: string, cost: number) =>
      turns.insert({
        at,
        task: taskId,
        agent: "acme-builder",
        account: "claude-acme",
        tool: "claude",
        auth: "login",
        org,
        project: null,
        runId: null,
        model: null,
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 1000,
        cacheWriteTokens: 30,
        costUsd: cost,
        costSource: "reported",
        estimated: false,
      });
    const repo = new AutonomyRepo(store.raw);
    repo.join("ACM-1", "2026-10-01T10:00:00.000Z");
    turn("ACM-1", "acme", "2026-10-01T09:00:00.000Z", 9); // before it joined
    turn("ACM-1", "acme", "2026-10-01T11:00:00.000Z", 1);
    turn("ACM-1", "acme", "2026-10-02T01:00:00.000Z", 7); // tomorrow
    turn("ACM-2", "acme", "2026-10-01T11:00:00.000Z", 5); // not autonomous
    turn("LOCAL-1", null, "2026-10-01T12:00:00.000Z", 0.5); // the autonomy chat
    turn("LOCAL-2", null, "2026-10-01T12:00:00.000Z", 3); // another chat
    const rows = repo.spendRows("2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", ["LOCAL-1"]);
    // Cache reads are left out, as budgets count them: 100 + 20 + 30.
    expect(rows.sort((a, b) => a.org.localeCompare(b.org))).toEqual([
      { org: "acme", tokens: 150, cost: 1 },
      { org: "private", tokens: 150, cost: 0.5 },
    ]);
    store.close();
  });
});
