import type { ConnectionConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { createDeployCredentials } from "./credentials.ts";

const conn = (c: Partial<ConnectionConfig> & Pick<ConnectionConfig, "type">): ConnectionConfig =>
  ({ name: "c", ...c }) as ConnectionConfig;

const all: Record<string, { org: string; connection: ConnectionConfig }> = {
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
  it("come from the project's own workspace", async () => {
    expect(await credentials.git("acme", "github.com", "github")).toEqual({
      token: "acme-token-for-github.com",
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
    expect(await credentials.git("globex", "github.com", "github")).toEqual({
      problem: "globex is not signed in to github.com",
    });
    for (const result of [
      await credentials.variable("globex", "acme-vercel", "VERCEL_TOKEN"),
      await credentials.ssh("globex", "acme-host"),
    ]) {
      expect(result).toMatchObject({
        problem: expect.stringContaining("only uses its own workspace's connections"),
      });
    }
  });

  it("refuse a connection of the wrong kind and a variable it does not have", async () => {
    expect(await credentials.variable("acme", "acme-host", "VERCEL_TOKEN")).toEqual({
      problem: "acme-host is not a variables connection.",
    });
    expect(await credentials.variable("acme", "acme-vercel", "OTHER")).toEqual({
      problem: "acme-vercel has no OTHER.",
    });
  });
});
