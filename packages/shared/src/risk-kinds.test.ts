import { describe, expect, it } from "vitest";
import { levelAllows } from "./risk-kinds.ts";

describe("each level allows exactly its row and nothing more", () => {
  it("never lets secrets, a client's server, deleting outside, going over budget, a new image or the unknown through, at any level", () => {
    for (const level of ["ask", "routine", "full"] as const) {
      for (const kind of [
        "secret",
        "client-server-write",
        "delete-outside",
        "over-budget",
        "new-image",
        "other",
      ] as const) {
        expect([
          level,
          kind,
          levelAllows(level, kind, { incident: { fix: "ships", clientUpdate: "sends" }, incidentFix: true }),
        ]).toEqual([level, kind, false]);
      }
    }
  });

  it("gives an incident's fix to the owner under Ask me and to the captain, as far as that one fix goes, under Captain ships", () => {
    const fix = ["push-branch", "merge-main", "deploy-staging", "deploy-production"] as const;
    for (const level of ["ask", "routine", "full"] as const) {
      // Ask me: nothing past the level's own row.
      const owned = fix.map((kind) =>
        levelAllows(level, kind, { incident: { fix: "ask" }, incidentFix: true }),
      );
      const row = fix.map((kind) => levelAllows(level, kind));
      expect(owned).toEqual(row);
      // Captain ships: the whole fix, at every level.
      const ships = fix.map((kind) =>
        levelAllows(level, kind, { incident: { fix: "ships" }, incidentFix: true }),
      );
      expect(ships).toEqual([true, true, true, true]);
      // Only the incident's own fix: the same switch gives nothing to other work.
      const other = fix.map((kind) => levelAllows(level, kind, { incident: { fix: "ships" } }));
      expect(other).toEqual(row);
    }
  });
});
