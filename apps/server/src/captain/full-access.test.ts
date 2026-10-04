import type { AutonomySettings } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { authorityOf, keptRowOf } from "./levels.ts";

const settings = (orgs: AutonomySettings["orgs"]): Pick<AutonomySettings, "orgs"> => ({ orgs });

describe("full access", () => {
  it("gives every row to the captain when the owner kept nothing", () => {
    const a = authorityOf(settings({ acme: { fullAccess: true } }), "acme");
    expect(Object.values(a).every((v) => v === "decide")).toBe(true);
  });

  it("keeps Merge and Push with the owner when their rows say so, and gives the rest", () => {
    const a = authorityOf(
      settings({
        acme: {
          fullAccess: true,
          authority: {
            start: "ask",
            questions: "ask",
            approvals: "ask",
            upkeep: "ask",
            merge: "ask",
            push: "decide",
            own: "ask",
          },
        },
      }),
      "acme",
    );
    expect(a).toEqual({
      start: "decide",
      questions: "decide",
      approvals: "decide",
      upkeep: "decide",
      merge: "ask",
      push: "decide",
      own: "decide",
    });
  });

  it("names the row merging and pushing commands still need", () => {
    for (const c of ["tasks.merge", "tasks.mergeMrs", "tasks.markMerged", "tasks.resolveShip"]) {
      expect(keptRowOf(c)).toBe("merge");
    }
    expect(keptRowOf("tasks.push")).toBe("push");
    expect(keptRowOf("tasks.openMrs")).toBe("push");
    expect(keptRowOf("tasks.start")).toBeUndefined();
  });
});
