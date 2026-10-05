import { describe, expect, it } from "vitest";
import { reloadDecision } from "./build-id.ts";

describe("reloadDecision", () => {
  it("does nothing for the same build", () => {
    expect(reloadDecision({ mine: "a1", server: "a1", unsent: false })).toBe("none");
    expect(reloadDecision({ mine: "a1", server: "a1", unsent: true })).toBe("none");
  });

  it("reloads at once for a different build when nothing is unsent", () => {
    expect(reloadDecision({ mine: "a1", server: "b2", unsent: false })).toBe("reload");
  });

  it("asks for a different build when a composer holds unsent text", () => {
    expect(reloadDecision({ mine: "a1", server: "b2", unsent: true })).toBe("ask");
  });

  it("never reloads for a build with no id", () => {
    expect(reloadDecision({ mine: "dev", server: "b2", unsent: false })).toBe("none");
    expect(reloadDecision({ mine: "a1", server: undefined, unsent: false })).toBe("none");
  });
});
