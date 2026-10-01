import { describe, expect, it } from "vitest";
import { agentCommitter, agentOfCommitter, attributionEnabled, withTaskTrailer } from "./attribution.ts";

describe("commit attribution", () => {
  it("names the committer after the agent and reads the agent back", () => {
    const committer = agentCommitter("acme-lead");
    expect(committer).toEqual({ name: "acme-lead via majhi", email: "majhi@majhi.local" });
    expect(agentOfCommitter(committer)).toBe("acme-lead");
  });

  it("does not take a person for an agent", () => {
    expect(agentOfCommitter({ name: "Ada via majhi", email: "ada@acme.test" })).toBeUndefined();
    expect(agentOfCommitter({ name: "majhi", email: "majhi@majhi.local" })).toBeUndefined();
    expect(agentOfCommitter({ name: " via majhi", email: "majhi@majhi.local" })).toBeUndefined();
  });

  it("adds the task trailer once, joining an existing trailer block", () => {
    expect(withTaskTrailer("fix: a\n", "ACM-1")).toBe("fix: a\n\nMajhi-Task: ACM-1");
    expect(withTaskTrailer("fix: a\n\nMajhi-Task: ACM-1", "ACM-1")).toBe("fix: a\n\nMajhi-Task: ACM-1");
    expect(withTaskTrailer("fix: a\n\nWhy.\n\nSigned-off-by: Ada <a@b.c>", "ACM-1")).toBe(
      "fix: a\n\nWhy.\n\nSigned-off-by: Ada <a@b.c>\nMajhi-Task: ACM-1",
    );
  });

  it("is on unless a level turns it off, and the nearest level wins", () => {
    expect(attributionEnabled({})).toBe(true);
    expect(attributionEnabled({ global: { attribution: false } })).toBe(false);
    expect(attributionEnabled({ global: { attribution: false }, org: { attribution: true } })).toBe(true);
    expect(
      attributionEnabled({
        global: { attribution: true },
        org: { attribution: true },
        project: { attribution: false },
      }),
    ).toBe(false);
    // A level that sets nothing passes to the next.
    expect(attributionEnabled({ global: { attribution: false }, org: {}, project: {} })).toBe(false);
  });
});
