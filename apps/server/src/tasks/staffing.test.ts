import { describe, expect, it } from "vitest";
import { handoverNote } from "./handover.ts";
import { type StaffAccount, type StaffAgent, type StaffInput, staffTask } from "./staffing.ts";

const agent = (id: string, account: string, extra: Partial<StaffAgent> = {}): StaffAgent => ({
  id,
  scope: "acme",
  where: ["acme"],
  role: "Builder",
  account,
  skills: [],
  tier: "balanced",
  ...extra,
});
const account = (id: string, extra: Partial<StaffAccount> = {}): StaffAccount => ({
  id,
  usable: true,
  freeSlots: 2,
  windowLeftPct: 80,
  weeklyLeftPct: 80,
  ...extra,
});
const input = (
  agents: StaffAgent[],
  accounts: StaffAccount[],
  extra: Partial<StaffInput> = {},
): StaffInput => ({
  task: { title: "Add a health endpoint", brief: "Add GET /health to the api", kind: "code", org: "acme" },
  size: "small",
  agents,
  accounts: new Map(accounts.map((a) => [a.id, a])),
  floors: { window: 10, weekly: 5 },
  ...extra,
});

describe("staffTask", () => {
  it("picks the idle account over the saturated one, and says why in one line", () => {
    const busy = agent("acme-a", "claude-busy");
    const idle = agent("acme-b", "claude-idle");
    const out = staffTask(
      input(
        [busy, idle],
        [
          account("claude-busy", { freeSlots: 0, windowLeftPct: 15 }),
          account("claude-idle", { freeSlots: 2, windowLeftPct: 60 }),
        ],
      ),
    );
    expect(out.lead).toBe("acme-b");
    expect(out.team).toEqual(["acme-b"]);
    expect(out.reason.startsWith("@acme-b leads on claude-idle: ")).toBe(true);
    expect(out.reason).toContain("free slot");
    expect(out.reason).toContain("60% of its window left");
    expect(out.reason.includes("\n")).toBe(false);
  });

  it("prefers the account with more usage left when slots are equal", () => {
    const out = staffTask(
      input(
        [agent("acme-a", "x"), agent("acme-b", "y")],
        [account("x", { windowLeftPct: 25 }), account("y", { windowLeftPct: 90 })],
      ),
    );
    expect(out.lead).toBe("acme-b");
  });

  it("leaves out an account under its floor, an unusable one and one over the budget", () => {
    const under = agent("acme-under", "u");
    const down = agent("acme-down", "d");
    const dear = agent("acme-dear", "p", { pricePerMTok: 100 });
    const fine = agent("acme-fine", "f");
    const out = staffTask(
      input(
        [under, down, dear, fine],
        [
          account("u", { windowLeftPct: 8 }),
          account("d", { usable: false }),
          account("p"),
          account("f", { windowLeftPct: 20 }),
        ],
        { budgetLeftUsd: 5 },
      ),
    );
    expect(out.ranked.map((r) => r.agent)).toEqual(["acme-fine"]);
    const weekly = staffTask(input([under], [account("u", { windowLeftPct: 50, weeklyLeftPct: 3 })]));
    expect(weekly.lead).toBeUndefined();
    expect(weekly.reason).toContain("weekly floor");
  });

  it("never uses another workspace's agents or the captain", () => {
    const out = staffTask(
      input(
        [
          agent("globex-a", "g", { scope: "globex", where: ["globex"] }),
          agent("boss", "x", { scope: "root", where: ["anywhere"], role: "Lead" }),
          agent("acme-a", "x"),
        ],
        [account("g"), account("x")],
        { boss: "boss" },
      ),
    );
    expect(out.team).toEqual(["acme-a"]);
    expect(out.ranked.map((r) => r.agent)).toEqual(["acme-a"]);
    const none = staffTask(
      input([agent("globex-a", "g", { scope: "globex", where: ["globex"] })], [account("g")]),
    );
    expect(none.team).toEqual([]);
    expect(none.lead).toBeUndefined();
  });

  it("matches the model tier to the size: a large task goes to the most capable, a small one to a cheaper", () => {
    const strong = agent("acme-strong", "x", { tier: "most-capable" });
    const cheap = agent("acme-cheap", "y", { tier: "cheapest" });
    const accounts = [account("x"), account("y")];
    expect(staffTask(input([strong, cheap], accounts, { size: "large" })).lead).toBe("acme-strong");
    expect(staffTask(input([strong, cheap], accounts, { size: "small" })).lead).toBe("acme-cheap");
  });

  it("builds a bigger team for a bigger task, only with agents that have a free slot", () => {
    const agents = [
      agent("acme-lead", "x", { role: "Lead", tier: "most-capable" }),
      agent("acme-builder", "y"),
      agent("acme-reviewer", "z", { role: "Reviewer", tier: "most-capable" }),
      agent("acme-stuck", "w"),
    ];
    const accounts = [account("x"), account("y"), account("z"), account("w", { freeSlots: 0 })];
    const small = staffTask(input(agents, accounts, { size: "small" }));
    expect(small.team).toHaveLength(1);
    const large = staffTask(input(agents, accounts, { size: "large" }));
    expect(large.team[0]).toBe("acme-lead");
    expect(large.team).toContain("acme-builder");
    expect(large.team).toContain("acme-reviewer");
    expect(large.team).not.toContain("acme-stuck");
    expect(large.reason).toContain("joins");
  });

  it("weighs past results in the repo when they exist, and says when they do not", () => {
    const a = agent("acme-a", "x");
    const b = agent("acme-b", "y");
    const accounts = [account("x"), account("y")];
    const without = staffTask(input([a, b], accounts));
    expect(without.reason).toContain("no past results in this repo to weigh");
    const history = new Map([
      ["acme-a", { done: 0, failed: 4 }],
      ["acme-b", { done: 5, failed: 0 }],
    ]);
    const withHistory = staffTask(input([a, b], accounts, { history, repo: "acme-api" }));
    expect(withHistory.lead).toBe("acme-b");
    expect(withHistory.reason).toContain("5 finished in acme-api");
    expect(withHistory.reason).not.toContain("no past results");
  });

  it("does not let a Reviewer lead", () => {
    const out = staffTask(
      input([agent("acme-r", "x", { role: "Reviewer" }), agent("acme-b", "y")], [account("x"), account("y")]),
    );
    expect(out.lead).toBe("acme-b");
  });
});

describe("handoverNote", () => {
  it("carries the plan, what is done and what is next", () => {
    const note = handoverNote({
      task: "ACM-3",
      from: "acme-lead",
      to: "acme-builder",
      by: "@acme-lead",
      reason: "my account is at its limit",
      plan: {
        steps: [
          { who: "me", what: "design the route" },
          { who: "@acme-builder", what: "write the handler" },
        ],
        why: "small change",
        how: ["alone"],
      },
      commits: [{ project: "acme-api", subjects: ["feat: add route", "test: cover route"] }],
      oldStays: false,
    });
    expect(note).toContain("1. me: design the route");
    expect(note).toContain("2. @acme-builder: write the handler");
    expect(note).toContain("- acme-api:\n  - feat: add route\n  - test: cover route");
    expect(note).toContain("Next:");
    expect(note).toContain("@acme-lead left the team.");
  });
});
