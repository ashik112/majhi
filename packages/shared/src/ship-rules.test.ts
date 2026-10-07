import { describe, expect, it } from "vitest";
import { ALL_ASK, type Authority } from "./authority.ts";
import { type ShipFacts, type ShipRule, shipSteps } from "./ship-rules.ts";

const rule = (id: string, over: Partial<ShipRule> & Pick<ShipRule, "when">): ShipRule => ({
  id,
  merge: "decide",
  deployStaging: "decide",
  deployProduction: "ask",
  tell: "decide",
  ...over,
});

const bugRule = rule("aaaaaaaa", { when: { types: ["bug", "incident"], maxChangedLines: 200 } });
const anyRule = rule("bbbbbbbb", { when: { types: [] }, merge: "ask", deployStaging: "ask", tell: "ask" });
const bug: ShipFacts = { type: "bug", changedLines: 38, projects: ["storefront"] };

describe("ship steps", () => {
  it("the first matching rule decides, whatever the later ones say", () => {
    const s = shipSteps(ALL_ASK, [bugRule, anyRule], bug, true);
    expect(s.rule).toBe("aaaaaaaa");
    expect([s.merge, s.deployStaging, s.deployProduction, s.tell]).toEqual([
      "captain",
      "captain",
      "owner",
      "captain",
    ]);
  });

  it("with no match the rows decide", () => {
    const rows: Authority = { ...ALL_ASK, merge: "decide", push: "decide" };
    const s = shipSteps(
      rows,
      [bugRule],
      { type: "feature", changedLines: 10, projects: ["storefront"] },
      true,
    );
    expect(s).toEqual({
      merge: "captain",
      push: "captain",
      deployStaging: "owner",
      deployProduction: "owner",
      tell: "owner",
      rule: undefined,
    });
  });

  it("a rule never applies to a task it cannot see: untyped, too big, size or areas unknown", () => {
    const sized = rule("cccccccc", { when: { types: ["bug"], maxChangedLines: 100 } });
    const inWeb = rule("dddddddd", { when: { types: ["bug"], areas: ["web"] } });
    const ask = (facts: ShipFacts, r: ShipRule) => shipSteps(ALL_ASK, [r], facts, true).merge;
    expect(ask({ projects: ["a"], changedLines: 5 }, sized)).toBe("owner");
    expect(ask({ type: "bug", changedLines: 101, projects: ["a"] }, sized)).toBe("owner");
    expect(ask({ type: "bug", projects: ["a"] }, sized)).toBe("owner");
    expect(ask({ type: "bug", changedLines: 5, projects: ["a"] }, sized)).toBe("captain");
    expect(ask({ type: "bug", projects: ["a"] }, inWeb)).toBe("owner");
    expect(ask({ type: "bug", areas: ["web", "api"], projects: ["a"] }, inWeb)).toBe("owner");
    expect(ask({ type: "bug", areas: ["web"], unmapped: 1, projects: ["a"] }, inWeb)).toBe("owner");
    expect(ask({ type: "bug", areas: ["web"], unmapped: 0, projects: ["a"] }, inWeb)).toBe("captain");
  });

  it("a project rule covers a task only when every project it changes is listed", () => {
    const only = rule("eeeeeeee", { when: { types: [], projects: ["storefront"] } });
    expect(shipSteps(ALL_ASK, [only], { projects: ["storefront"] }, true).merge).toBe("captain");
    expect(shipSteps(ALL_ASK, [only], { projects: ["storefront", "billing"] }, true).merge).toBe("owner");
  });

  it("while Autonomous is not On every step is the owner's, rules included", () => {
    const rows: Authority = { ...ALL_ASK, merge: "decide", push: "decide", tell: "decide" };
    const s = shipSteps(rows, [bugRule], bug, false);
    expect([s.merge, s.push, s.deployStaging, s.deployProduction, s.tell, s.rule]).toEqual([
      "owner",
      "owner",
      "owner",
      "owner",
      "owner",
      undefined,
    ]);
  });

  it("Push stays on its row: a rule cannot widen it", () => {
    expect(shipSteps(ALL_ASK, [bugRule], bug, true).push).toBe("owner");
  });
});
