import { AutonomyPatchSchema, AutonomySettingsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { authorityOf } from "../captain/levels.ts";
import { mergePatch } from "./configure.ts";

describe("autonomy.configure", () => {
  it("changes only the rows a patch names; Deploy, Tell and Own keep their saved value", () => {
    const current = AutonomySettingsSchema.parse({
      orgs: {
        acme: {
          authority: {
            start: "decide",
            questions: "decide",
            approvals: "decide",
            upkeep: "decide",
            merge: "decide",
            push: "decide",
            deployStaging: "decide",
            deployProduction: "decide",
            tell: "decide",
            own: "decide",
          },
        },
      },
    });
    const patch = AutonomyPatchSchema.parse({ orgs: { acme: { authority: { merge: "ask" } } } });
    const next = authorityOf(mergePatch(current, patch), "acme");
    expect(next).toEqual({
      start: "decide",
      questions: "decide",
      approvals: "decide",
      upkeep: "decide",
      merge: "ask",
      push: "decide",
      deployStaging: "decide",
      deployProduction: "decide",
      tell: "decide",
      own: "decide",
    });
  });
});
