import { toolSetting, withToolSetting } from "@majhi/shared";
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
  it("gives a builder alone processes and memory, and no majhi-decide", () => {
    expect(gateTools(agent(), ctx)).toEqual(["majhi-processes", "majhi-memory"]);
  });

  it("attaches majhi-decide only to an agent that lists it", () => {
    expect(gateTools(agent({ tools: ["majhi-decide"] }), ctx)).toContain("majhi-decide");
    expect(gateTools(agent({ role: "Lead", scope: "root" }), { ...ctx, teamSize: 3 })).not.toContain(
      "majhi-decide",
    );
    expect(gateTools(agent({ tools: ["majhi-decide", "-majhi-decide"] }), ctx)).not.toContain("majhi-decide");
  });

  it("gives a team member the room, and a lead tasks too", () => {
    const team = { ...ctx, teamSize: 3 };
    expect(gateTools(agent(), team)).toContain("majhi-room");
    expect(gateTools(agent(), team)).not.toContain("majhi-tasks");
    expect(gateTools(agent({ role: "Lead" }), team)).toEqual(
      expect.arrayContaining(["majhi-room", "majhi-tasks"]),
    );
  });

  it("gives the agents of an ops task majhi-tasks, but not the captain", () => {
    const ops = { ...ctx, opsTask: true };
    expect(gateTools(agent(), ops)).toContain("majhi-tasks");
    expect(gateTools(agent(), ctx)).not.toContain("majhi-tasks");
    expect(gateTools(agent({ id: "majhi-boss", role: "Lead", scope: "root" }), ops)).not.toContain(
      "majhi-tasks",
    );
  });

  it("gives a lone lead of a lead-mode task the room", () => {
    expect(gateTools(agent({ role: "Lead" }), { ...ctx, soloLead: true })).toContain("majhi-room");
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

  it("gives containers to everyone only when majhi can run them", () => {
    expect(gateTools(agent(), ctx)).not.toContain("majhi-containers");
    expect(gateTools(agent(), { ...ctx, containersOn: true })).toContain("majhi-containers");
  });
});

describe("gateTools: the agent's tools list", () => {
  it("adds a server the role does not get", () => {
    const got = gateTools(agent({ tools: ["majhi-room", "majhi-tasks"] }), ctx);
    expect(got).toEqual(expect.arrayContaining(["majhi-room", "majhi-tasks"]));
  });

  it("turns a default off with a dash", () => {
    const got = gateTools(agent({ tools: ["-majhi-processes"] }), ctx);
    expect(got).not.toContain("majhi-processes");
    expect(got).toContain("majhi-memory");
  });

  it("turns off a default that only applies by rule, such as the room of a team", () => {
    expect(gateTools(agent({ tools: ["-majhi-room"] }), { ...ctx, teamSize: 2 })).not.toContain("majhi-room");
  });

  it("a dash cannot take majhi-admin from the captain", () => {
    const boss = agent({ id: "majhi-boss", role: "Root", scope: "root", tools: ["-majhi-admin"] });
    expect(gateTools(boss, ctx)).toContain("majhi-admin");
  });

  it("a dash wins over a bare name for the same server", () => {
    expect(gateTools(agent({ tools: ["majhi-room", "-majhi-room"] }), ctx)).not.toContain("majhi-room");
  });
});

describe("gateTools: serena", () => {
  const ready = { ...ctx, serena: true };

  it("goes to builders with a worktree when the runner can start it", () => {
    expect(gateTools(agent(), ready)).toContain("serena");
    expect(gateTools(agent(), ctx)).not.toContain("serena");
    expect(gateTools(agent(), { ...ready, hasWorktrees: false })).not.toContain("serena");
  });

  it("is not a default for reviewers, but can be added, and removed from builders", () => {
    expect(gateTools(agent({ role: "Reviewer" }), ready)).not.toContain("serena");
    expect(gateTools(agent({ role: "Reviewer", tools: ["serena"] }), ready)).toContain("serena");
    expect(gateTools(agent({ tools: ["-serena"] }), ready)).not.toContain("serena");
  });
});

describe("tools list settings", () => {
  it("reads and writes the three settings without touching other entries", () => {
    const tools = ["serena", "-majhi-decide"];
    expect(toolSetting(tools, "serena")).toBe("added");
    expect(toolSetting(tools, "majhi-decide")).toBe("off");
    expect(toolSetting(tools, "majhi-room")).toBe("default");
    expect(withToolSetting(tools, "majhi-decide", "default")).toEqual(["serena"]);
    expect(withToolSetting(tools, "serena", "off")).toEqual(["-majhi-decide", "-serena"]);
    expect(withToolSetting(["majhi-room"], "majhi-room", "added")).toEqual(["majhi-room"]);
  });
});
