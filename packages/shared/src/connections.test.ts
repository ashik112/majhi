import { describe, expect, it } from "vitest";
import {
  activeFields,
  activeLists,
  ConnectionConfigSchema,
  connectionProblems,
  duplicateConnectionIds,
  suggestConnectionId,
} from "./connections.ts";

const kubectl = {
  type: "kubectl",
  name: "Acme prod",
  fields: { kubeconfig: "file:kubeconfig", context: "prod" },
} as const;

describe("ConnectionConfigSchema", () => {
  it("reads a connection with references only", () => {
    expect(ConnectionConfigSchema.safeParse(kubectl).success).toBe(true);
    const mail = {
      type: "mail",
      name: "Ops mailbox",
      fields: {
        mode: "imap",
        imap_host: "imap.acme.com",
        user: "ops@acme.com",
        password: "secret:acme-mail",
      },
    };
    expect(ConnectionConfigSchema.safeParse(mail).success).toBe(true);
  });

  it("refuses a secret value in place of a reference", () => {
    const mail = { type: "mail", name: "Ops", fields: { password: "hunter2-hunter2" } };
    expect(ConnectionConfigSchema.safeParse(mail).success).toBe(false);
    const env = { type: "env", name: "Keys", vars: { API_KEY: { kind: "secret", value: "sk-live-1234" } } };
    expect(ConnectionConfigSchema.safeParse(env).success).toBe(false);
  });

  it("refuses fields and lists the type does not declare, and kinds a list does not take", () => {
    expect(ConnectionConfigSchema.safeParse({ ...kubectl, fields: { url: "https://x" } }).success).toBe(
      false,
    );
    expect(ConnectionConfigSchema.safeParse({ ...kubectl, headers: {} }).success).toBe(false);
    const fileHeader = {
      type: "mcp",
      name: "New Relic",
      headers: { "Api-Key": { kind: "file", value: "file:key" } },
    };
    expect(ConnectionConfigSchema.safeParse(fileHeader).success).toBe(false);
    expect(ConnectionConfigSchema.safeParse({ ...kubectl, fields: { context: "a\nb" } }).success).toBe(false);
  });

  it("refuses variables that steer majhi or the agent CLIs", () => {
    for (const name of [
      "PATH",
      "LD_PRELOAD",
      "GIT_CONFIG_COUNT",
      "ANTHROPIC_BASE_URL",
      "MAJHI_TASK",
      "KUBECONFIG",
      "https_proxy",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "DOCKER_CONFIG",
    ]) {
      const env = { type: "env", name: "Keys", vars: { [name]: { kind: "text", value: "x" } } };
      expect(ConnectionConfigSchema.safeParse(env).success, name).toBe(false);
    }
    const ok = { type: "env", name: "Keys", vars: { AWS_REGION: { kind: "text", value: "eu-west-1" } } };
    expect(ConnectionConfigSchema.safeParse(ok).success).toBe(true);
  });

  it("refuses the same header twice in another case", () => {
    const mcp = {
      type: "mcp",
      name: "New Relic",
      headers: { "Api-Key": { kind: "secret" }, "api-key": { kind: "text", value: "x" } },
    };
    expect(ConnectionConfigSchema.safeParse(mcp).success).toBe(false);
  });
});

describe("which fields count", () => {
  it("follows the transport of an MCP server, remote by default", () => {
    expect(activeFields("mcp").map((f) => f.key)).toEqual([
      "transport",
      "url",
      "protocol",
      "read_tools",
      "write_tools",
    ]);
    expect(activeFields("mcp", { transport: "local" }).map((f) => f.key)).toEqual([
      "transport",
      "command",
      "read_tools",
      "write_tools",
    ]);
    expect(activeLists("mcp").map((l) => l.key)).toEqual(["headers"]);
    expect(activeLists("mail", { mode: "mcp", transport: "local" }).map((l) => l.key)).toEqual(["env"]);
    expect(activeLists("mail")).toEqual([]);
  });
});

describe("connectionProblems", () => {
  it("names required fields and entries that are not set", () => {
    expect(connectionProblems({ type: "kubectl", name: "x", fields: { context: "prod" } })).toEqual([
      "Kubeconfig is not set",
    ]);
    const remote = { type: "mcp", name: "x", headers: { "Api-Key": { kind: "secret" } } } as const;
    expect(connectionProblems(remote)).toEqual(["URL is not set", "Api-Key is not set"]);
    const local = { type: "mcp", name: "x", fields: { transport: "local", command: "npx srv" } } as const;
    expect(connectionProblems(local)).toEqual([]);
  });

  it("counts a reference as set only when it points at something", () => {
    const missing = () => false;
    expect(connectionProblems(kubectl, missing)).toEqual(["Kubeconfig is not set"]);
    expect(connectionProblems(kubectl)).toEqual([]);
  });

  it("checks formats", () => {
    const mail = {
      type: "mail",
      name: "x",
      fields: { imap_host: "imap.acme.com", imap_port: "99999", user: "ops", password: "secret:p" },
    } as const;
    expect(connectionProblems(mail)).toEqual(["IMAP port is a port, 1 to 65535"]);
    const ftp = { type: "mcp", name: "x", fields: { url: "ftp://mcp.acme.com" } } as const;
    expect(connectionProblems(ftp)).toEqual(["URL is a web address, like https://mcp.acme.com/mcp"]);
  });
});

it("finds a connection id used by two orgs", () => {
  const orgs = {
    acme: { connections: { prod: {}, logs: {} } },
    globex: { connections: { prod: {} } },
    initech: {},
  };
  expect(duplicateConnectionIds(orgs)).toEqual([{ id: "prod", orgs: ["acme", "globex"] }]);
});

it("suggests a free id from the name", () => {
  expect(suggestConnectionId("Acme prod cluster", new Set())).toBe("acme-prod-cluster");
  expect(suggestConnectionId("Über logs!", new Set(["uber-logs"]))).toBe("uber-logs-2");
  expect(suggestConnectionId("***", new Set())).toBe("connection");
});
