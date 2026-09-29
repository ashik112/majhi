import { type AccountStatus, type AgentFrontmatter, canWorkIn } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { pickDefaultAgent } from "./agents.ts";

function agent(
  id: string,
  scope: string,
  role: AgentFrontmatter["role"],
  extra: Partial<AgentFrontmatter> = {},
): AgentFrontmatter {
  return {
    id,
    scope,
    role,
    account: `acct-${id}`,
    where: ["anywhere"],
    perms: [],
    tools: [],
    connections: [],
    skills: [],
    origin: "owner",
    ...extra,
  };
}

const agents = [
  agent("majhi-boss", "root", "Root"),
  agent("acme-builder", "acme", "Builder"),
  agent("acme-lead", "acme", "Lead"),
  agent("acme-reviewer", "acme", "Reviewer"),
  agent("beta-lead", "beta", "Lead"),
  agent("helper", "root", "Builder"),
];
const healthy = new Map<string, AccountStatus>();

describe("canWorkIn", () => {
  it("lets org agents work in their own org only, unless where names another", () => {
    const b = agent("b", "acme", "Builder");
    expect(canWorkIn(b, "acme")).toBe(true);
    expect(canWorkIn(b, "beta")).toBe(false);
    expect(canWorkIn(agent("b", "acme", "Builder", { where: ["acme", "beta"] }), "beta")).toBe(true);
    expect(canWorkIn(agent("b", "acme", "Builder", { where: ["beta"] }), "acme")).toBe(false);
  });

  it("lets root agents work where their where allows, and alone in LOCAL tasks", () => {
    expect(canWorkIn(agent("r", "root", "Root"), "beta")).toBe(true);
    expect(canWorkIn(agent("r", "root", "Root", { where: ["acme"] }), "beta")).toBe(false);
    expect(canWorkIn(agent("r", "root", "Root"), undefined)).toBe(true);
    expect(canWorkIn(agent("b", "acme", "Builder"), undefined)).toBe(false);
  });
});

describe("pickDefaultAgent", () => {
  it("prefers the org's Lead, then its Builder, before root agents", () => {
    expect(pickDefaultAgent({ agents, org: "acme", boss: "majhi-boss", accountStatus: healthy })).toBe(
      "acme-lead",
    );
    const noLead = agents.filter((a) => a.id !== "acme-lead");
    expect(
      pickDefaultAgent({ agents: noLead, org: "acme", boss: "majhi-boss", accountStatus: healthy }),
    ).toBe("acme-builder");
  });

  it("falls back to root agents when the org has none, Builder before Root", () => {
    expect(pickDefaultAgent({ agents, org: "gamma", boss: "majhi-boss", accountStatus: healthy })).toBe(
      "helper",
    );
  });

  it("skips agents on accounts that cannot run, then falls back to them", () => {
    const status = new Map<string, AccountStatus>([["acct-acme-lead", "at-limit"]]);
    expect(pickDefaultAgent({ agents, org: "acme", boss: undefined, accountStatus: status })).toBe(
      "acme-builder",
    );
    const all = new Map<string, AccountStatus>(agents.map((a) => [a.account, "needs-login"]));
    expect(pickDefaultAgent({ agents, org: "acme", boss: undefined, accountStatus: all })).toBe("acme-lead");
  });

  it("sends a task without an org to the boss", () => {
    expect(pickDefaultAgent({ agents, org: undefined, boss: "majhi-boss", accountStatus: healthy })).toBe(
      "majhi-boss",
    );
    expect(pickDefaultAgent({ agents, org: undefined, boss: undefined, accountStatus: healthy })).toBe(
      "helper",
    );
  });

  it("returns nothing when nobody can work there", () => {
    expect(
      pickDefaultAgent({
        agents: [agent("b", "acme", "Builder")],
        org: "beta",
        boss: undefined,
        accountStatus: healthy,
      }),
    ).toBeUndefined();
  });
});
