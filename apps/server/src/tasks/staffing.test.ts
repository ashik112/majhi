import { describe, expect, it } from "vitest";
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
});
