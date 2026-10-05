import { describe, expect, it } from "vitest";
import { ConnectionConfigSchema, duplicateConnectionIds } from "./connections.ts";

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

it("finds a connection id used by two orgs", () => {
  const orgs = {
    acme: { connections: { prod: {}, logs: {} } },
    globex: { connections: { prod: {} } },
    initech: {},
  };
  expect(duplicateConnectionIds(orgs)).toEqual([{ id: "prod", orgs: ["acme", "globex"] }]);
});

describe("ssh targets", () => {
  it("takes an alias, user@address and a port, and never an option", async () => {
    const { SSH_TARGET, sshTargetArgs } = await import("./connections.ts");
    for (const ok of ["acme-prod", "root@203.0.113.10", "deploy@db.acme.example:2222", "203.0.113.10"]) {
      expect(SSH_TARGET.test(ok), ok).toBe(true);
    }
    for (const bad of ["-oProxyCommand=evil", "root@-oX", "a b", "root@host;rm", "x:99999999"]) {
      expect(SSH_TARGET.test(bad), bad).toBe(false);
    }
    expect(sshTargetArgs("deploy@db.acme.example:2222")).toEqual([
      "-p",
      "2222",
      "--",
      "deploy@db.acme.example",
    ]);
    expect(sshTargetArgs("acme-prod")).toEqual(["--", "acme-prod"]);
  });
});

describe("ssh keys", () => {
  it("uses exactly the chosen key, and only a public key in ~/.ssh", async () => {
    const { SSH_PUBKEY, sshTargetArgs } = await import("./connections.ts");
    expect(sshTargetArgs("root@203.0.113.10", { pub: "~/.ssh/client.pub" })).toEqual([
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "IdentityFile=~/.ssh/client.pub",
      "--",
      "root@203.0.113.10",
    ]);
    for (const ok of ["~/.ssh/id_ed25519.pub", "~/.ssh/client-a.pub"])
      expect(SSH_PUBKEY.test(ok), ok).toBe(true);
    for (const bad of ["~/.ssh/id_ed25519", "~/.ssh/../.aws/x.pub", "/etc/x.pub", "~/.ssh/a b.pub"]) {
      expect(SSH_PUBKEY.test(bad), bad).toBe(false);
    }
  });
});
