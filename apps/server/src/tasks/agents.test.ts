import { type AgentFrontmatter, canWorkIn } from "@majhi/shared";
import { describe, expect, it } from "vitest";

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
    origin: "owner",
    ...extra,
  };
}

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
