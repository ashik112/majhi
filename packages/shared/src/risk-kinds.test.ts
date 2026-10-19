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
});
