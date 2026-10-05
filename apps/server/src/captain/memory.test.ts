import { describe, expect, it } from "vitest";
import { laneOfScope, laneScopes } from "./memory-scopes.ts";

const PROJECTS = { "acme-api": { org: "acme" }, "globex-web": { org: "globex" }, notes: { org: "private" } };

describe("which workspace reviews which memories", () => {
  it("gives global memories to Private, and a client workspace only its own", () => {
    expect(laneScopes("private", PROJECTS)).toEqual(["global", "org:private", "project:notes"]);
    expect(laneScopes("acme", PROJECTS)).toEqual(["org:acme", "project:acme-api"]);
    expect(laneOfScope("global", PROJECTS)).toBe("private");
    expect(laneOfScope("project:globex-web", PROJECTS)).toBe("globex");
    expect(laneOfScope("org:acme", PROJECTS)).toBe("acme");
    expect(laneOfScope("project:gone", PROJECTS)).toBeUndefined();
  });
});
