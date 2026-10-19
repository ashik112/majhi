import { type AutonomyHold, AutonomySettingsSchema, type CommandName } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { adminTools } from "../admin/tools.ts";
import { hardLimit, type LimitWorld } from "./limits.ts";
import { type AutonomyCall, decideAutonomously, type PolicyContext, startsWork } from "./policy.ts";

const settings = AutonomySettingsSchema.parse({
  orgs: {
    acme: { level: "routine" },
    globex: { level: "full" },
    northwind: { level: "ask" },
  },
});

function call(command: CommandName, input: Record<string, unknown> = {}, extra: Partial<AutonomyCall> = {}) {
  return { command, input, org: "acme", confirm: false, ...extra };
}

function ctx(extra: Partial<PolicyContext> = {}): PolicyContext {
  return { settings, holds: [], accounts: [], ...extra };
}

const decide = (c: AutonomyCall, x: PolicyContext = ctx()) => decideAutonomously(c, x).decision;

// ---------------------------------------------------------------------------

function world(org = "acme"): LimitWorld {
  return {
    org,
    orgs: {
      private: {},
      acme: {
        mr_tokens: { gitlab: "secret:acme-gitlab" },
        git_accounts: [
          { host: "gitlab.com", account: "acme-dev", ssh: "gitlab-acme", token: "secret:acme-dev-token" },
        ],
        connections: { "acme-k8s": { type: "kubectl", name: "Acme cluster", fields: { context: "prod" } } },
      },
      globex: {
        git_accounts: [{ host: "github.com", account: "globex-bot" }],
        connections: {
          "globex-db": {
            type: "env",
            name: "Globex DB",
            vars: { DB_PASSWORD: { kind: "secret", value: "secret:globex-db" } },
          },
        },
      },
    },
    accounts: {
      "claude-acme": { org: "acme" },
      "claude-globex": { org: "globex" },
      "api-private": { org: "private", key: "secret:anthropic-private" },
    },
    agents: {
      "acme-builder": { scope: "acme", account: "claude-acme", where: ["anywhere"], connections: [] },
      "acme-roamer": { scope: "acme", account: "claude-acme", where: ["acme", "globex"], connections: [] },
      boss: { scope: "root", account: "api-private", where: ["anywhere"], connections: ["globex-db"] },
      "globex-root": { scope: "root", account: "claude-globex", where: ["globex"], connections: [] },
      "globex-loose": { scope: "root", account: "claude-globex", where: ["anywhere"], connections: [] },
    },
    logins: [
      { host: "github.com", via: "gh", account: "globex-bot" },
      { host: "gitlab.com", via: "glab", account: "acme-dev" },
    ],
  };
}

const limit = (command: string, input: Record<string, unknown>, w: LimitWorld = world(), reason?: string) =>
  hardLimit({ command, input, ...(reason === undefined ? {} : { reason }) }, w);

describe("decideAutonomously: the authority level", () => {
  const at = (level: "ask" | "routine" | "full"): PolicyContext =>
    ctx({ settings: AutonomySettingsSchema.parse({ orgs: { acme: { level } } }) });

  it("merges at Full only", () => {
    expect(decide(call("tasks.merge", { id: "ACM-1" }), at("full"))).toBe("approved");
    expect(decide(call("tasks.merge", { id: "ACM-1" }), at("routine"))).toBe("left");
    expect(decide(call("tasks.merge", { id: "ACM-1" }), at("ask"))).toBe("left");
  });
});
