import { describe, expect, it } from "vitest";
import { type GateContext, gateTools } from "./gating.ts";

const ctx: GateContext = {
  boss: "majhi-boss",
  teamSize: 1,
  soloLead: false,
  containersOn: false,
  serena: false,
  hasWorktrees: true,
};

type Role = "Lead" | "Builder" | "Reviewer" | "Tester" | "Root";

const agent = (patch: Partial<{ id: string; role: Role; scope: string; tools: string[] }> = {}) => ({
  id: "acme-builder",
  role: "Builder" as Role,
  scope: "acme",
  tools: [] as string[],
  ...patch,
});

describe("gateTools: the defaults are what agents had before gating", () => {
  it("attaches majhi-decide only to an agent that lists it", () => {
    expect(gateTools(agent({ tools: ["majhi-decide"] }), ctx)).toContain("majhi-decide");
    expect(gateTools(agent({ role: "Lead", scope: "root" }), { ...ctx, teamSize: 3 })).not.toContain(
      "majhi-decide",
    );
    expect(gateTools(agent({ tools: ["majhi-decide", "-majhi-decide"] }), ctx)).not.toContain("majhi-decide");
  });

  it("gives the agents of an ops task majhi-tasks, but not the captain", () => {
    const ops = { ...ctx, opsTask: true };
    expect(gateTools(agent(), ops)).toContain("majhi-tasks");
    expect(gateTools(agent(), ctx)).not.toContain("majhi-tasks");
    expect(gateTools(agent({ id: "majhi-boss", role: "Lead", scope: "root" }), ops)).not.toContain(
      "majhi-tasks",
    );
  });

  it("gives a root agent tasks, and admin only when it lists it", () => {
    const root = agent({ id: "setup", role: "Root", scope: "root" });
    expect(gateTools(root, ctx)).toContain("majhi-tasks");
    expect(gateTools(root, ctx)).not.toContain("majhi-admin");
    expect(gateTools({ ...root, tools: ["majhi-admin"] }, ctx)).toContain("majhi-admin");
  });

  it("gives the captain admin but not tasks", () => {
    const boss = gateTools(agent({ id: "majhi-boss", role: "Root", scope: "root" }), ctx);
    expect(boss).toContain("majhi-admin");
    expect(boss).not.toContain("majhi-tasks");
  });
});

describe("gateTools: the agent's tools list", () => {
  it("a dash cannot take majhi-admin from the captain", () => {
    const boss = agent({ id: "majhi-boss", role: "Root", scope: "root", tools: ["-majhi-admin"] });
    expect(gateTools(boss, ctx)).toContain("majhi-admin");
  });
});
