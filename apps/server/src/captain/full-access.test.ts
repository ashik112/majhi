import type { AutonomySettings } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { authorityOf } from "./levels.ts";

const settings = (orgs: AutonomySettings["orgs"]): Pick<AutonomySettings, "orgs"> => ({ orgs });

describe("full access", () => {
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
            deployStaging: "ask",
            deployProduction: "ask",
            tell: "ask",
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
      deployStaging: "ask",
      deployProduction: "ask",
      tell: "ask",
      own: "decide",
    });
  });

  it("never grants a deploy or a reply to the client, even with nothing saved", () => {
    const a = authorityOf(settings({ acme: { fullAccess: true } }), "acme");
    expect([a.deployStaging, a.deployProduction, a.tell]).toEqual(["ask", "ask", "ask"]);
  });
});
