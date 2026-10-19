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
  it.each(["ask", "routine", "full"] as const)("%s", (level) => {
    const allowed = RISK_KINDS.filter((kind) => levelAllows(level, kind));
    expect(allowed).toEqual(ALLOWED[level]);
  });

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

  it("asks for production and client messages unless the workspace says Captain ships", () => {
    for (const level of ["ask", "routine", "full"] as const) {
      expect(levelAllows(level, "deploy-production")).toBe(false);
      expect(levelAllows(level, "client-message")).toBe(false);
      // The two switches are the only way past it, and each covers its own thing.
      expect(levelAllows(level, "client-message", { incident: { clientUpdate: "sends" } })).toBe(true);
      expect(levelAllows(level, "deploy-production", { incident: { clientUpdate: "sends" } })).toBe(false);
      expect(levelAllows(level, "deploy-production", { incident: { fix: "ships" } })).toBe(false);
      // Only for an incident's own fix, and then a merge and a staging deploy go with it.
      const fix = { incident: { fix: "ships" as const }, incidentFix: true };
      expect(levelAllows(level, "deploy-production", fix)).toBe(true);
      expect(levelAllows(level, "merge-main", fix)).toBe(true);
      expect(levelAllows(level, "deploy-staging", fix)).toBe(true);
      expect(levelAllows(level, "client-message", fix)).toBe(false);
    }
  });

  it("derives the nine rows the captain reads from the level alone", () => {
    expect(authorityFromLevel("ask")).toEqual({
      start: "ask",
      questions: "ask",
      approvals: "ask",
      upkeep: "decide",
      merge: "ask",
      push: "ask",
      deployStaging: "ask",
      deployProduction: "ask",
      tell: "ask",
    });
    expect(authorityFromLevel("routine", { clientUpdate: "sends" })).toEqual({
      start: "decide",
      questions: "decide",
      approvals: "decide",
      upkeep: "decide",
      merge: "ask",
      push: "decide",
      deployStaging: "ask",
      deployProduction: "ask",
      tell: "decide",
    });
    expect(authorityFromLevel("full").merge).toBe("decide");
    expect(authorityFromLevel("full", { fix: "ships" }).deployProduction).toBe("ask");
  });
});

describe("an Always rule", () => {
  const rules = [{ org: "acme", kind: "merge-main" as const }];

  it("holds for its workspace and kind only, and never lifts a kind that always asks", () => {
    expect(riskVerdict("routine", rules, "acme", "merge-main")).toEqual({ go: true, by: "rule" });
    expect(riskVerdict("routine", rules, "globex", "merge-main")).toEqual({ go: false });
    expect(riskVerdict("routine", rules, "acme", "deploy-staging")).toEqual({ go: false });
    expect(riskVerdict("ask", [{ org: "acme", kind: "push-branch" }], "acme", "push-branch")).toEqual({
      go: true,
      by: "rule",
    });
    // A level that allows it says so first.
    expect(riskVerdict("full", rules, "acme", "merge-main")).toEqual({ go: true, by: "level" });
    expect(riskVerdict("full", rules, "acme", "secret")).toEqual({ go: false });
  });
});

describe("official images", () => {
  it.each([
    ["postgres:16-alpine", true],
    ["redis", true],
    ["library/node:22", true],
    ["docker.io/library/nginx:1.27", true],
    ["postgres@sha256:abc", true],
    ["acme/api:1", false],
    ["ghcr.io/acme/api:1", false],
    ["docker.io/acme/api", false],
    ["localhost:5000/postgres", false],
    ["quay.io/library/postgres", false],
    ["", false],
  ])("%s is official: %s", (ref, official) => {
    expect(isOfficialImage(ref)).toBe(official);
  });
});
