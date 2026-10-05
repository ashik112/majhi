import { AutonomySettingsSchema, type BudgetAsk } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { withRaises } from "./budget-asks.ts";
import { AutonomyRepo } from "./repo.ts";
import { capHoldFor, holdsOf, spendOf } from "./spend.ts";

/**
 * Money and limits: a raise holds for its day only and never touches the saved budget; each budget is
 * asked about once a day; a workspace without a budget of its own shares the autonomous one.
 */

const TODAY = "2026-10-04";
const TOMORROW = "2026-10-05";
const window = (day: string) => ({ day, end: `${day}T23:59:59.000Z` });

const saved = AutonomySettingsSchema.parse({
  day: { cost: 20 },
  orgs: { hooli: { cap: { cost: 20 } }, acme: {} },
});
const rows = [{ org: "hooli", tokens: 1000, cost: 20 }];
/** Room under the autonomous budget, so only Hooli's own budget runs out. */
const roomy = AutonomySettingsSchema.parse({ ...saved, day: { cost: 100 } });

function ask(scope: string, day: string): BudgetAsk {
  return {
    scope,
    name: scope,
    day,
    cap: { cost: 20 },
    raiseTo: { cost: 40 },
    waiting: 3,
    text: "x",
    at: `${day}T10:00:00.000Z`,
  };
}

describe("a raise for today", () => {
  it("lifts the hold today, leaves the roomy budget alone and is gone tomorrow", () => {
    const names = { hooli: "Hooli" };
    const held = holdsOf(spendOf(rows, roomy, window(TODAY), "UTC"), [], names);
    expect(held.map((h) => h.kind)).toEqual(["org-cap"]);

    const store = new Store(":memory:");
    const repo = new AutonomyRepo(store.raw);
    expect(repo.addBudgetAsk(ask("hooli", TODAY))).toBe(true);
    expect(repo.answerBudgetAsk("hooli", TODAY, "raised", `${TODAY}T11:00:00.000Z`)).toBe(true);

    const today = withRaises(roomy, repo.raisedBudgets(TODAY));
    expect(today.orgs.hooli?.cap).toEqual({ cost: 40 });
    expect(holdsOf(spendOf(rows, today, window(TODAY), "UTC"), [], names)).toEqual([]);
    // The roomy setting is the same object it was.
    expect(roomy.orgs.hooli?.cap).toEqual({ cost: 20 });

    // Tomorrow nothing is raised: the roomy budget holds the same spend again.
    const tomorrow = withRaises(roomy, repo.raisedBudgets(TOMORROW));
    expect(tomorrow).toBe(roomy);
    expect(holdsOf(spendOf(rows, tomorrow, window(TOMORROW), "UTC"), [], names).map((h) => h.kind)).toEqual([
      "org-cap",
    ]);
  });

  it("does not count a question that was left, and never lowers a budget the owner set higher", () => {
    const store = new Store(":memory:");
    const repo = new AutonomyRepo(store.raw);
    repo.addBudgetAsk(ask("day", TODAY));
    repo.answerBudgetAsk("day", TODAY, "left", `${TODAY}T11:00:00.000Z`);
    expect(repo.raisedBudgets(TODAY)).toEqual({});
    expect(withRaises(saved, { day: { cost: 40 } }).day).toEqual({ cost: 40 });
    const higher = AutonomySettingsSchema.parse({ ...saved, day: { cost: 100 } });
    expect(withRaises(higher, { day: { cost: 40 } }).day).toEqual({ cost: 100 });
  });

  it("raises the autonomous budget, which lifts the hold of every workspace", () => {
    const day = AutonomySettingsSchema.parse({ day: { cost: 20 }, orgs: { acme: {} } });
    const spent = [{ org: "acme", tokens: 10, cost: 20 }];
    const held = holdsOf(spendOf(spent, day, window(TODAY), "UTC"), []);
    expect(capHoldFor(held, "acme")?.kind).toBe("day-cap");
    const raised = withRaises(day, { day: { cost: 40 } });
    expect(holdsOf(spendOf(spent, raised, window(TODAY), "UTC"), [])).toEqual([]);
  });
});

describe("a workspace without a budget", () => {
  it("shares the whole autonomous budget and is held only by it", () => {
    const spent = [{ org: "acme", tokens: 10, cost: 19 }];
    const spend = spendOf(spent, saved, window(TODAY), "UTC");
    // Acme has no budget of its own: its use is not capped, only the total is.
    expect(spend.orgs.find((o) => o.org === "acme")).toMatchObject({ reached: false, percent: 0 });
    expect(spend.total.percent).toBe(95);
    expect(holdsOf(spend, [])).toEqual([]);
    const over = spendOf([{ org: "acme", tokens: 10, cost: 20 }], saved, window(TODAY), "UTC");
    expect(holdsOf(over, []).map((h) => h.kind)).toEqual(["day-cap"]);
    // A raise of a workspace that has no budget gives it none.
    expect(withRaises(saved, { acme: { cost: 40 } }).orgs.acme?.cap).toBeUndefined();
  });
});
