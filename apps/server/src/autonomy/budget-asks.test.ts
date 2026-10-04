import { AutonomySettingsSchema, type BudgetAsk } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { askableHolds, askText, buildAsk, doubled, waitText, withRaises } from "./budget-asks.ts";
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

describe("one question per budget and day", () => {
  it("is asked once a day, then again the next day", () => {
    const repo = new AutonomyRepo(new Store(":memory:").raw);
    expect(repo.addBudgetAsk(ask("hooli", TODAY))).toBe(true);
    expect(repo.addBudgetAsk(ask("hooli", TODAY))).toBe(false);
    expect(repo.hasBudgetAsk("hooli", TODAY)).toBe(true);
    expect(repo.hasBudgetAsk("hooli", TOMORROW)).toBe(false);
    // Answered or not, it is not asked again that day.
    repo.answerBudgetAsk("hooli", TODAY, "left", `${TODAY}T11:00:00.000Z`);
    expect(repo.addBudgetAsk(ask("hooli", TODAY))).toBe(false);
    expect(repo.pendingBudgetAsks(TODAY)).toEqual([]);
    expect(repo.addBudgetAsk(ask("hooli", TOMORROW))).toBe(true);
    expect(repo.pendingBudgetAsks(TOMORROW).map((a) => a.scope)).toEqual(["hooli"]);
    expect(repo.pendingBudgetAsks(TODAY)).toEqual([]);
  });

  it("asks about the autonomous budget when it ran out, not about each workspace under it", () => {
    const both = AutonomySettingsSchema.parse({ day: { cost: 5 }, orgs: { hooli: { cap: { cost: 2 } } } });
    const held = holdsOf(spendOf([{ org: "hooli", tokens: 1, cost: 6 }], both, window(TODAY), "UTC"), []);
    expect(held.map((h) => h.kind).sort()).toEqual(["day-cap", "org-cap"]);
    expect(askableHolds(held).map((h) => h.kind)).toEqual(["day-cap"]);
  });

  it("asks nothing while nothing waits, and words the question with the doubled budget", () => {
    const spend = spendOf(rows, saved, window(TODAY), "UTC");
    const input = { scope: "hooli", name: "Hooli", spend, day: TODAY, at: `${TODAY}T10:00:00.000Z` };
    expect(buildAsk({ ...input, waiting: 0 })).toBeUndefined();
    const made = buildAsk({ ...input, waiting: 3 });
    expect(made?.text).toBe(
      "Hooli used its $20 for today. 3 tasks are waiting. Raise it to $40 for today?",
    );
    expect(made?.raiseTo).toEqual({ cost: 40 });
    expect(askText("Acme", { cost: 7.5 }, doubled({ cost: 7.5 }), 1)).toBe(
      "Acme used its $7.50 for today. 1 task is waiting. Raise it to $15 for today?",
    );
    expect(doubled({ tokens: 1_000_000 })).toEqual({ tokens: 2_000_000 });
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

describe("what a held task says", () => {
  it("names the budget and what it used", () => {
    expect(waitText("hooli", "Hooli", 20)).toBe("Waiting for Hooli's daily budget, $20 used");
    expect(waitText("day", "Autonomous work", 20.5)).toBe(
      "Waiting for the autonomous daily budget, $20.50 used",
    );
  });
});
