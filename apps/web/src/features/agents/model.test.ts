import type { AccountView, AgentEntry, OrgView } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  accountsForScope,
  agentDot,
  agentState,
  agentSubline,
  buildOptions,
  draftFromAgent,
  fallbackCandidates,
  groupAgents,
  newAgentFrontmatter,
  optionChips,
  rolesForScope,
  scopeBadge,
  scopeForAccount,
  suggestAgentId,
  toggleWhere,
  updateInput,
  worksOutsideScope,
} from "./model";

function ok(id: string, scope: string, extra: { isBoss?: boolean; account?: string } = {}): AgentEntry {
  return {
    status: "ok",
    file: `/h/agents/${id}.md`,
    warnings: [],
    isBoss: extra.isBoss ?? false,
    agent: {
      frontmatter: {
        id,
        scope,
        role: "Builder",
        account: extra.account ?? "claude-acme",
        where: ["anywhere"],
        perms: ["edit"],
        tools: ["serena"],
        connections: [],
        skills: ["write-tests"],
        origin: "owner",
      },
      instructions: "Do the work.",
    },
  };
}

function account(id: string, org: string, status: AccountView["status"] = "healthy"): AccountView {
  return { id, tool: "claude", org, auth: "login", home: "/h", agentCount: 0, status };
}

const orgs: OrgView[] = [
  { id: "acme", name: "Acme", key: "ACM", color: "#8ab8f5", accountCount: 1, agentCount: 1 },
  { id: "zed", name: "Zed", key: "ZED", accountCount: 0, agentCount: 0 },
];

describe("groupAgents", () => {
  it("puts root first, then orgs in order, including empty ones", () => {
    const groups = groupAgents([ok("b", "acme"), ok("a", "root")], orgs);
    expect(groups.map((g) => [g.scope, g.entries.length])).toEqual([
      ["root", 1],
      ["acme", 1],
      ["zed", 0],
    ]);
    expect(groups[1]?.color).toBe("#8ab8f5");
  });
  it("lists the boss first, then by id", () => {
    const groups = groupAgents(
      [ok("a", "root"), ok("z-boss", "root", { isBoss: true }), ok("m", "root")],
      [],
    );
    expect(groups[0]?.entries.map((e) => (e.status === "ok" ? e.agent.frontmatter.id : ""))).toEqual([
      "z-boss",
      "a",
      "m",
    ]);
  });
  it("keeps unknown scopes and invalid files visible", () => {
    const invalid: AgentEntry = {
      status: "invalid",
      file: "/h/agents/bad.md",
      id: "bad",
      errors: ["role: bad"],
    };
    const groups = groupAgents([ok("x", "gone"), invalid], orgs);
    expect(groups.map((g) => g.scope)).toEqual(["root", "acme", "zed", "gone", "invalid"]);
    expect(groups.at(-1)?.canAdd).toBe(false);
    expect(groups.at(-2)?.canAdd).toBe(false);
  });
});

describe("accountsForScope", () => {
  const accounts = [account("p", "personal"), account("a", "acme"), account("z", "zed")];
  it("gives root agents every account", () => {
    expect(accountsForScope(accounts, "root").map((a) => a.id)).toEqual(["p", "a", "z"]);
  });
  it("gives an org's agents that org's accounts and personal ones, never another org's", () => {
    expect(accountsForScope(accounts, "acme").map((a) => a.id)).toEqual(["p", "a"]);
  });
  it("maps personal accounts to the root scope", () => {
    expect(scopeForAccount({ org: "personal" })).toBe("root");
    expect(scopeForAccount({ org: "acme" })).toBe("acme");
  });
});

describe("agentDot", () => {
  const accounts = [account("claude-acme", "acme", "needs-login")];
  it("follows the account status without a health check", () => {
    expect(agentDot(ok("a", "acme"), accounts).tone).toBe("red");
    expect(agentDot(ok("a", "acme"), [account("claude-acme", "acme")]).tone).toBe("green");
  });
  it("prefers a fresh health check", () => {
    const health = { ok: true, checkedAt: "x", durationMs: 1, steps: [] };
    expect(agentDot(ok("a", "acme"), accounts, health).tone).toBe("green");
  });
  it("flags a missing account and an invalid file", () => {
    expect(agentDot(ok("a", "acme", { account: "nope" }), accounts).label).toBe("Account not found");
    expect(agentDot({ status: "invalid", file: "f", id: "x", errors: ["e"] }, accounts).tone).toBe("red");
  });
});

describe("buildOptions", () => {
  const offered = [
    { id: "sonnet", name: "Sonnet" },
    { id: "opus", name: "opus" },
  ];
  it("lists account default, auto, then the offered values", () => {
    const { options, warning } = buildOptions("model", offered, "sonnet", "opus");
    expect(options.map((o) => o.value)).toEqual(["", "auto", "sonnet", "opus"]);
    expect(options[0]?.label).toBe("Account default (opus)");
    expect(options[2]?.label).toBe("Sonnet (sonnet)");
    expect(warning).toBeUndefined();
  });
  it("accepts auto and an unset value without a warning", () => {
    expect(buildOptions("model", offered, "auto").warning).toBeUndefined();
    expect(buildOptions("model", offered, undefined).warning).toBeUndefined();
  });
  it("keeps a saved value that is no longer offered, with a warning", () => {
    const { options, warning } = buildOptions("effort", offered, "ultra");
    expect(options.at(-1)).toEqual({ value: "ultra", label: "ultra (not offered)" });
    expect(warning).toContain('"ultra"');
  });
  it("does not warn while the list is still loading", () => {
    const { options, warning } = buildOptions("model", undefined, "sonnet");
    expect(options.map((o) => o.value)).toEqual(["", "auto", "sonnet"]);
    expect(warning).toBeUndefined();
  });
});

describe("toggleWhere", () => {
  it("switches between anywhere and orgs, never empty", () => {
    expect(toggleWhere(["anywhere"], "acme")).toEqual(["acme"]);
    expect(toggleWhere(["acme"], "zed")).toEqual(["acme", "zed"]);
    expect(toggleWhere(["acme", "zed"], "acme")).toEqual(["zed"]);
    expect(toggleWhere(["acme"], "acme")).toEqual(["anywhere"]);
    expect(toggleWhere(["acme"], "anywhere")).toEqual(["anywhere"]);
  });
});

describe("updateInput", () => {
  const entry = ok("a", "acme");
  if (entry.status !== "ok") throw new Error("fixture");
  it("keeps fields the editor does not show", () => {
    const draft = {
      ...draftFromAgent(entry.agent),
      model: "sonnet",
      perms: ["edit" as const, "push" as const],
    };
    const input = updateInput(entry.agent, draft);
    expect(input.id).toBe("a");
    expect(input.frontmatter.skills).toEqual(["write-tests"]);
    expect(input.frontmatter.tools).toEqual(["serena"]);
    expect(input.frontmatter.model).toBe("sonnet");
    expect(input.frontmatter.perms).toEqual(["edit", "push"]);
    expect(input.frontmatter).not.toHaveProperty("effort");
  });
  it("writes the auto model list only when the model is auto", () => {
    const base = draftFromAgent(entry.agent);
    expect(updateInput(entry.agent, { ...base, model: "auto", models: ["a"] }).frontmatter.models).toEqual([
      "a",
    ]);
    expect(
      updateInput(entry.agent, { ...base, model: "sonnet", models: ["a"] }).frontmatter,
    ).not.toHaveProperty("models");
  });
});

describe("suggestAgentId and newAgentFrontmatter", () => {
  it("skips taken ids", () => {
    expect(suggestAgentId("acme", "claude", [])).toBe("acme-claude");
    expect(suggestAgentId("acme", "claude", ["acme-claude", "acme-claude-2"])).toBe("acme-claude-3");
  });
  it("defaults root agents to anywhere and org agents to their org", () => {
    expect(newAgentFrontmatter("root", "Root", "a").where).toEqual(["anywhere"]);
    expect(newAgentFrontmatter("acme", "Builder", "a").where).toEqual(["acme"]);
  });
});

describe("agent presentation", () => {
  it("badges root as RT and orgs by their first two letters", () => {
    expect(scopeBadge("root", "Root")).toBe("RT");
    expect(scopeBadge("acme", "Acme")).toBe("AC");
    expect(scopeBadge("x", "!!")).toBe("?");
  });

  it("offers Root only to root agents, and keeps a role the agent already has", () => {
    expect(rolesForScope("root", "Root")).toEqual(["Root", "Lead", "Builder", "Reviewer"]);
    expect(rolesForScope("acme", "Builder")).toEqual(["Lead", "Builder", "Reviewer", "Tester"]);
    expect(rolesForScope("acme", "Root")).toEqual(["Lead", "Builder", "Reviewer", "Tester", "Root"]);
  });

  it("describes an agent on one line", () => {
    const entry = ok("acme-lead", "acme");
    if (entry.status !== "ok") throw new Error("fixture");
    expect(agentSubline(entry.agent)).toBe("Builder · claude-acme · account default");
  });

  it("lets an org agent fall back to its org or root, never itself", () => {
    const list = [ok("a", "acme"), ok("b", "acme"), ok("c", "zed"), ok("r", "root")];
    const self = list[0];
    if (self?.status !== "ok") throw new Error("fixture");
    const ids = fallbackCandidates(list, self).map((e) => (e.status === "ok" ? e.agent.frontmatter.id : ""));
    expect(ids).toEqual(["b", "r"]);
  });

  it("warns when an org agent may work outside its org", () => {
    expect(worksOutsideScope("acme", ["acme"])).toBe(false);
    expect(worksOutsideScope("acme", ["anywhere"])).toBe(true);
    expect(worksOutsideScope("acme", ["acme", "zed"])).toBe(true);
    expect(worksOutsideScope("root", ["anywhere"])).toBe(false);
  });

  it("names the special model chips and keeps ids on the rest", () => {
    const offered = [
      { id: "sonnet-5.5", name: "Sonnet 5.5" },
      { id: "haiku", name: "haiku" },
    ];
    const chips = optionChips(buildOptions("model", offered, "gone", "sonnet-5.5"), offered);
    expect(chips.map((c) => c.label)).toEqual([
      "Account default",
      "Auto",
      "sonnet-5.5",
      "haiku",
      "gone (not offered)",
    ]);
    expect(chips[2]?.title).toBe("Sonnet 5.5");
    expect(chips[3]?.title).toBeUndefined();
  });
});

describe("agentState", () => {
  const entry = ok("acme-builder", "acme");
  if (entry.status !== "ok") throw new Error("fixture");
  const task = (
    over: Partial<{ id: string; status: "running" | "paused"; team: string[]; working: string[] }>,
  ) => ({
    id: "ACM-1",
    status: "running" as const,
    team: ["acme-builder"],
    working: [] as string[],
    ...over,
  });

  it("says working, paused, limit, error and idle, in that order", () => {
    const fine = { status: "healthy" as const };
    expect(agentState(entry, fine, [task({ working: ["acme-builder"] })])).toMatchObject({
      kind: "working",
      label: "Working on ACM-1",
    });
    expect(agentState(entry, fine, [task({ status: "paused" })])).toMatchObject({
      kind: "paused",
      label: "Paused on ACM-1",
    });
    expect(agentState(entry, { status: "at-limit" }, [])).toMatchObject({ kind: "limit" });
    expect(agentState(entry, { status: "needs-login" }, [])).toMatchObject({ kind: "error" });
    expect(agentState(entry, undefined, [])).toMatchObject({ kind: "error" });
    expect(agentState(entry, fine, [task({})])).toMatchObject({ kind: "idle", label: "Idle" });
  });
});
