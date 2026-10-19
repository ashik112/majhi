import { AutonomySettingsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { capHoldFor, diffHolds, holdsOf, spendOf } from "./spend.ts";

const settings = AutonomySettingsSchema.parse({
  day: { cost: 2 },
  orgs: { acme: { cap: { cost: 1 } }, globex: { cap: { tokens: 1000 } }, northwind: { push: true } },
});
const window = { day: "2026-10-01", end: "2026-10-02T00:00:00.000Z" };

describe("spendOf", () => {
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
