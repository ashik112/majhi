import type { ConnectionConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { createDeployCredentials } from "./credentials.ts";

const conn = (c: Partial<ConnectionConfig> & Pick<ConnectionConfig, "type">): ConnectionConfig =>
  ({ name: "c", ...c }) as ConnectionConfig;

const all: Record<string, { org: string; connection: ConnectionConfig }> = {
  "acme-github": { org: "acme", connection: conn({ type: "git", fields: { provider: "github" } }) },
  "globex-github": { org: "globex", connection: conn({ type: "git", fields: { provider: "github" } }) },
  "acme-vercel": {
    org: "acme",
    connection: conn({
      type: "env",
      vars: { VERCEL_TOKEN: { kind: "secret", value: "secret:acme-vercel-token" } },
    }),
  },
  "acme-host": {
    org: "acme",
    connection: conn({ type: "ssh", fields: { alias: "deploy@203.0.113.7", key: "~/.ssh/acme.pub" } }),
  },
};

const credentials = createDeployCredentials({
  connections: { find: async (id) => all[id] },
  secrets: { get: async (name) => (name === "acme-vercel-token" ? "vc-secret-value" : undefined) },
  gitToken: async (org, _provider, host) =>
    org === "acme"
      ? { token: `${org}-token-for-${host}` }
      : { problem: `${org} is not signed in to ${host}` },
});

describe("deploy credentials", () => {
  it("come from a connection of the project's own workspace", async () => {
    expect(await credentials.git("acme", "acme-github", "github")).toEqual({
      token: "acme-token-for-github.com",
      host: "github.com",
    });
    expect(await credentials.variable("acme", "acme-vercel", "VERCEL_TOKEN")).toEqual({
      value: "vc-secret-value",
    });
    expect(await credentials.ssh("acme", "acme-host")).toEqual({
      alias: "deploy@203.0.113.7",
      key: "~/.ssh/acme.pub",
    });
  });

  it("never reach another workspace's connection, whatever its kind", async () => {
    for (const result of [
      await credentials.git("acme", "globex-github", "github"),
      await credentials.git("globex", "acme-github", "github"),
      await credentials.variable("globex", "acme-vercel", "VERCEL_TOKEN"),
      await credentials.ssh("globex", "acme-host"),
    ]) {
      expect(result).toMatchObject({
        problem: expect.stringContaining("only uses its own workspace's connections"),
      });
    }
  });

  it("refuse a connection of the wrong kind, and a host the workspace did not sign in to", async () => {
    expect(await credentials.git("acme", "acme-host", "github")).toEqual({
      problem: "acme-host is not a git host connection.",
    });
    expect(await credentials.git("acme", "acme-github", "gitlab")).toEqual({
      problem: "acme-github is a github connection, not gitlab.",
    });
    expect(await credentials.variable("acme", "acme-vercel", "OTHER")).toEqual({
      problem: "acme-vercel has no OTHER.",
    });
  });
});
