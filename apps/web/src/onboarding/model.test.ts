import type { AccountView, AgentEntry } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { bossId, firstHealthyAccount, firstIncompleteStep, isExistingRootAgent } from "./model";

const account = (id: string, status: AccountView["status"]): AccountView => ({
  id,
  tool: "claude",
  org: "personal",
  auth: "login",
  home: "/h",
  agentCount: 0,
  status,
});
const agent = (id: string, isBoss: boolean): AgentEntry => ({
  status: "ok",
  file: `/h/${id}.md`,
  warnings: [],
  isBoss,
  agent: {
    frontmatter: {
      id,
      scope: "root",
      role: "Root",
      account: "a",
      where: ["anywhere"],
      perms: [],
      tools: [],
      connections: [],
      skills: [],
      origin: "setup",
    },
    instructions: "",
  },
});

describe("firstIncompleteStep", () => {
  it("starts at roots when there are none", () => {
    expect(firstIncompleteStep({ noRoots: true, accounts: [], agents: [] })).toBe("roots");
  });
  it("asks for an account when none is healthy", () => {
    expect(firstIncompleteStep({ noRoots: false, accounts: [], agents: [] })).toBe("account");
    expect(firstIncompleteStep({ noRoots: false, accounts: [account("a", "needs-login")], agents: [] })).toBe(
      "account",
    );
    expect(firstIncompleteStep({ noRoots: false, accounts: [account("a", "unknown")], agents: [] })).toBe(
      "account",
    );
  });
  it("asks for a boss when an account works but nobody is boss", () => {
    const state = { noRoots: false, accounts: [account("a", "healthy")], agents: [agent("x", false)] };
    expect(firstIncompleteStep(state)).toBe("boss");
  });
  it("is done with a healthy account and a boss", () => {
    const state = { noRoots: false, accounts: [account("a", "running-high")], agents: [agent("b", true)] };
    expect(firstIncompleteStep(state)).toBeNull();
  });
});

describe("firstHealthyAccount", () => {
  it("skips accounts that cannot run", () => {
    expect(firstHealthyAccount([account("a", "at-limit"), account("b", "healthy")])?.id).toBe("b");
  });
});

describe("bossId", () => {
  it("suggests majhi-boss and reuses an unfinished root agent of that name", () => {
    expect(bossId([])).toBe("majhi-boss");
    expect(bossId([agent("majhi-boss", false)])).toBe("majhi-boss");
    expect(isExistingRootAgent([agent("majhi-boss", false)], "majhi-boss")).toBe(true);
    expect(isExistingRootAgent([], "majhi-boss")).toBe(false);
  });
  it("bumps the id when a file with that name is broken or not root", () => {
    const broken: AgentEntry = { status: "invalid", file: "f", id: "majhi-boss", errors: ["x"] };
    expect(bossId([broken])).toBe("majhi-boss-2");
  });
});
