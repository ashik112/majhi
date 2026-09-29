import type { AgentEntry, OrgView } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { agentsByAccount, chipSplit, missingAccounts, usedByGroups, whereLabel } from "./used-by-model";

function ok(id: string, scope: string, account: string, isBoss = false): AgentEntry {
  return {
    status: "ok",
    file: `/h/${id}.md`,
    warnings: [],
    isBoss,
    agent: {
      frontmatter: {
        id,
        scope,
        role: "Builder",
        account,
        where: ["anywhere"],
        perms: [],
        tools: [],
        connections: [],
        skills: [],
        origin: "owner",
      },
      instructions: "",
    },
  };
}
const invalid: AgentEntry = { status: "invalid", file: "/h/bad.md", id: "bad", errors: ["x"] };
const orgs: OrgView[] = [
  { id: "acme", name: "Acme", key: "ACM", color: "#8ab8f5", accountCount: 1, agentCount: 1 },
  { id: "zed", name: "Zed", key: "ZED", accountCount: 0, agentCount: 0 },
];

describe("agentsByAccount", () => {
  it("groups valid agents by account, boss first", () => {
    const map = agentsByAccount([
      ok("b", "root", "p"),
      ok("a", "root", "p"),
      ok("boss", "root", "p", true),
      ok("c", "acme", "q"),
      invalid,
    ]);
    expect(map.get("p")?.map((e) => e.agent.frontmatter.id)).toEqual(["boss", "a", "b"]);
    expect([...map.keys()]).toEqual(["p", "q"]);
  });
});

describe("chipSplit", () => {
  it("keeps three chips and counts the rest", () => {
    expect(chipSplit([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3], more: 2 });
    expect(chipSplit([1, 2])).toEqual({ shown: [1, 2], more: 0 });
    expect(chipSplit([])).toEqual({ shown: [], more: 0 });
  });
});

describe("usedByGroups", () => {
  it("lists Root first, then orgs in order, without empty groups", () => {
    const list =
      agentsByAccount([ok("a", "acme", "x"), ok("r", "root", "x"), ok("s", "gone", "x")]).get("x") ?? [];
    expect(usedByGroups(list, orgs).map((g) => [g.scope, g.agents.length])).toEqual([
      ["root", 1],
      ["acme", 1],
      ["gone", 1],
    ]);
  });
  it("is empty for an unused account", () => {
    expect(usedByGroups([], orgs)).toEqual([]);
  });
});

describe("missingAccounts", () => {
  it("names accounts that files use but do not exist", () => {
    const entries = [
      ok("a", "root", "real"),
      ok("b", "acme", "gone"),
      ok("c", "acme", "gone"),
      ok("d", "root", "alsogone"),
      invalid,
    ];
    expect(missingAccounts(entries, ["real"])).toEqual([
      { account: "alsogone", agents: ["d"] },
      { account: "gone", agents: ["b", "c"] },
    ]);
  });
  it("is empty when every reference resolves", () => {
    expect(missingAccounts([ok("a", "root", "real")], ["real"])).toEqual([]);
  });
});

describe("whereLabel", () => {
  it("shows anywhere or org names", () => {
    expect(whereLabel(["anywhere"], orgs)).toBe("Anywhere");
    expect(whereLabel(["acme", "zed", "x"], orgs)).toBe("Acme, Zed, x");
  });
});
