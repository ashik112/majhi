import { describe, expect, it } from "vitest";
import { planSetup } from "./setup-ids.ts";

describe("the ids setup makes by itself", () => {
  it("never replace an existing account, workspace or agent: a clash gets a new id", () => {
    // An empty majhi gets the plain ids.
    expect(planSetup("claude", { orgs: [], accounts: [], agents: [] })).toEqual({
      org: { id: "me", name: "Personal" },
      account: "claude-me",
      lead: "me-lead",
      captain: { id: "majhi-boss", existing: false },
    });
    // Everything the plan would make is already there: each one moves on, and the captain stays.
    const taken = planSetup("claude", {
      orgs: ["me", "me-2", "acme"],
      accounts: ["claude-me", "claude-me-2", "claude-me-3"],
      agents: ["me-lead", "me-2-lead", "majhi-boss", "majhi-boss-2"],
      captain: "majhi-boss-2",
    });
    expect(taken.org).toEqual({ id: "me-3", name: "Personal 3" });
    expect(taken.account).toBe("claude-me-3-2");
    expect(taken.lead).toBe("me-3-lead");
    expect(taken.captain).toEqual({ id: "majhi-boss-2", existing: true });
    // A captain that is not set yet takes the next free id, never an agent that is called majhi-boss already.
    expect(planSetup("codex", { orgs: [], accounts: ["codex-me"], agents: ["majhi-boss"] })).toMatchObject({
      account: "codex-me-2",
      captain: { id: "majhi-boss-2", existing: false },
    });
  });
});
