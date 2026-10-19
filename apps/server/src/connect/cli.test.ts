import type { ConnectionConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { runConnections } from "../connections/access.ts";
import { planConnections } from "../connections/plan.ts";
import { connectionDir } from "../connections/service.ts";

describe("what a run of one workspace gets of a tool's sign-in", () => {
  const home = "/Users/owner/.majhi";
  const cli = (tool: string, account: string): ConnectionConfig => ({
    type: "cli",
    name: tool,
    fields: { tool, account },
  });
  const orgs = {
    acme: { connections: { vercel: cli("vercel", "ops@acme.example"), aws: cli("aws", "acme-prod") } },
    globex: { connections: { "vercel-2": cli("vercel", "dev@globex.example") } },
  };
  const deps = (oauth = async () => ({ problem: "none" })) => ({
    secrets: { get: async () => undefined },
    connectionDir: (id: string) => connectionDir(home, id),
    oauth,
  });

  it("gives a run in workspace A only A's folders and the tool's own variables", async () => {
    const held = runConnections({
      agent: { id: "acme-dev", scope: "acme" },
      task: { org: "acme", connections: [] },
      orgs,
    });
    const plan = await planConnections(held, "/run", deps());
    const text = JSON.stringify(plan);
    expect(plan.profiles.sort()).toEqual([
      `${home}/connections/aws/profile`,
      `${home}/connections/vercel/profile`,
    ]);
    expect(plan.env.XDG_DATA_HOME).toBe(`${home}/connections/vercel/profile/xdg/data`);
    expect(plan.env.AWS_CONFIG_FILE).toBe(`${home}/connections/aws/profile/aws/config`);
    // Nothing of workspace B, and nothing that moves the agent's own home.
    expect(text).not.toContain("vercel-2");
    expect(plan.env.HOME).toBeUndefined();
    expect(Object.keys(plan.env).sort()).toEqual([
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "XDG_DATA_HOME",
    ]);
    // Its changes ask first.
    expect(plan.gate.find((g) => g.id === "vercel")?.clis).toEqual(["vercel"]);
  });
});
