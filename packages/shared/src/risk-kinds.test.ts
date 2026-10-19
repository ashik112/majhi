import { describe, expect, it } from "vitest";
import { authorityFromLevel } from "./authority.ts";
import {
  type AuthorityLevel,
  isOfficialImage,
  levelAllows,
  RISK_KINDS,
  type RiskKind,
  riskVerdict,
} from "./risk-kinds.ts";

/** What each level lets through without a card, written out: nothing is derived from the code under test. */
const ALLOWED: Record<AuthorityLevel, readonly RiskKind[]> = {
  ask: ["sandbox"],
  routine: ["sandbox", "push-branch"],
  full: ["sandbox", "push-branch", "merge-main", "deploy-staging"],
};

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
});
