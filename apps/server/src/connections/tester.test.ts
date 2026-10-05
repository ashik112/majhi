import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { localSpawner } from "@majhi/acp";
import type { CommandMeta } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../agents/store.ts";
import { ConfigService } from "../config/service.ts";
import { SecretService } from "../secrets/service.ts";
import { generateKey, SecretStore } from "../secrets/store.ts";
import type { SshRun } from "../ssh/hosts.ts";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { UploadStore } from "../uploads/store.ts";
import { ConnectionService } from "./service.ts";
import { ConnectionTester } from "./tester.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };
const STAGING_TOKEN = "staging-admin-token-9876543210";
const API_KEY = "nr-api-key-0123456789abcdef";

const KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
  - { name: prod-eu, cluster: { server: "https://prod.acme.example:6443" } }
  - { name: staging, cluster: { server: "https://staging.acme.example:6443" } }
contexts:
  - { name: prod, context: { cluster: prod-eu, user: viewer } }
  - { name: staging, context: { cluster: staging, user: admin } }
users:
  - { name: viewer, user: { token: prod-viewer-token-0123456789 } }
  - { name: admin, user: { token: ${STAGING_TOKEN} } }
`;

describe("ConnectionTester", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let bin: string;
  let scratchRoot: string;
  let service: ConnectionService;
  let sshCalls: (readonly string[])[];
  let tester: (path?: string) => ConnectionTester;
  let secrets: SecretStore;
  let uploads: UploadStore;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    const majhiHome = join(dir, ".majhi");
    await mkdir(majhiHome, { recursive: true });
    const keyFile = join(dir, "config", "secrets.key");
    await writeKeyFile(keyFile, await generateKey());
    const config = new ConfigService({ majhiHome, hostHome: dir });
    await writeFile(config.file, "workspaces: [~/Work]\norgs:\n  acme: { name: Acme }\n");
    secrets = new SecretStore(majhiHome, keyFile);
    uploads = new UploadStore(majhiHome);
    service = new ConnectionService({
      config,
      secrets,
      secretService: new SecretService(secrets, config),
      uploads,
      agents: new AgentStore(majhiHome),
      majhiHome,
    });
    bin = join(dir, "bin");
    await mkdir(bin);
    await mkdir(join(dir, ".ssh"));
    await writeFile(join(dir, ".ssh", "config"), "Host acme-prod\n  HostName prod.acme.example\n");
    scratchRoot = join(dir, "Work", ".majhi", ".connections");
    sshCalls = [];
    tester = (path = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`) =>
      new ConnectionTester({
        connections: service,
        secrets,
        spawner: localSpawner,
        base: { PATH: path },
        scratchRoot: async () => scratchRoot,
        hostHome: dir,
        ssh: async (args): Promise<SshRun> => {
          sshCalls.push(args);
          return { code: 0, output: "" };
        },
      });
  });
  afterEach(() => cleanup());

  async function script(name: string, body: string): Promise<void> {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  }

  async function kubectl(): Promise<void> {
    await service.create(
      {
        org: "acme",
        id: "acme-prod",
        type: "kubectl",
        name: "Prod",
        fields: { context: "prod", namespace: "api" },
      },
      "connections.create",
      OWNER,
    );
    const upload = await uploads.save({
      name: "config",
      mime: "",
      data: new TextEncoder().encode(KUBECONFIG),
      purpose: "connection",
    });
    await service.setFile(
      { id: "acme-prod", field: "kubeconfig", upload: upload.id },
      "connections.setFile",
      OWNER,
    );
  }

  it("runs kubectl against a copy with only the context, outside majhi's environment, and cleans up", async () => {
    process.env.MAJHI_TEST_CANARY = "from-majhi";
    const seen = join(dir, "seen");
    await script(
      "kubectl",
      `cp "$KUBECONFIG" "${seen}-kubeconfig"; env > "${seen}-env"
case "$1 $2 $3" in
  "auth can-i --list") printf 'Resources  Non-Resource URLs  Resource Names  Verbs\\npods  []  []  [get list]\\nevents  []  []  [get]\\n';;
  "auth can-i delete") echo yes;;
  "auth can-i patch") echo no; exit 1;;
  *) exit 2;;
esac`,
    );
    await kubectl();
    const result = await tester().test("acme-prod");
    delete process.env.MAJHI_TEST_CANARY;

    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    const copy = await readFile(`${seen}-kubeconfig`, "utf8");
    expect(copy).toContain("namespace: api");
    expect(copy).not.toContain(STAGING_TOKEN);
    const env = await readFile(`${seen}-env`, "utf8");
    expect(env).not.toContain("MAJHI_TEST_CANARY");
    expect(env).toContain(`HOME=${scratchRoot}/test-`);
    expect(await readdir(scratchRoot)).toEqual([]);
    expect((await service.get("acme-prod")).lastTest?.ok).toBe(true);
  });

  it("runs the env test command with the values, and never shows a secret", async () => {
    await service.create(
      {
        org: "acme",
        id: "acme-keys",
        type: "env",
        name: "Keys",
        fields: { clis: "acme", test: 'acme whoami "$REGION"' },
        vars: { API_KEY: { kind: "secret" }, REGION: { kind: "text", value: "eu-west-1" } },
      },
      "connections.create",
      OWNER,
    );
    await service.setSecret(
      { id: "acme-keys", field: "API_KEY", list: "vars", value: API_KEY },
      "connections.setSecret",
      OWNER,
    );
    await script("acme", `echo "signed in with $API_KEY in $2"`);
    const result = await tester().test("acme-keys");
    expect(result.ok).toBe(true);
    expect(result.detail).not.toContain(API_KEY);
    expect(result.detail).toContain("[secret acme-keys.API_KEY]");
    expect(JSON.stringify(await service.get("acme-keys"))).not.toContain(API_KEY);
  });

  it("logs in over ssh to a known alias only, with the alias after --", async () => {
    await service.create(
      { org: "acme", id: "acme-box", type: "ssh", name: "Box", fields: { alias: "acme-prod" } },
      "connections.create",
      OWNER,
    );
    expect(await tester().test("acme-box")).toMatchObject({ ok: true });
    expect(sshCalls).toEqual([["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "acme-prod", "true"]]);
    await service.update({ id: "acme-box", fields: { alias: "acme-staging" } }, "connections.update", OWNER);
    expect((await tester().test("acme-box")).ok).toBe(false);
    expect(sshCalls).toHaveLength(1);
  });

  describe("typed failures: the call's result decides, never its words", () => {
    async function env(test: string): Promise<void> {
      await service.create(
        { org: "acme", id: "acme-keys", type: "env", name: "Keys", fields: { clis: "acme", test }, vars: {} },
        "connections.create",
        OWNER,
      );
    }

    it("exit 127 is a missing tool, any other exit is a tool that is not signed in, whatever it printed", async () => {
      await env("acme whoami");
      await script("acme", "echo 'everything is fine, you are connected'; exit 1");
      expect((await tester().test("acme-keys")).failure).toMatchObject({
        reason: "not-signed-in",
        status: 1,
      });
      await script("acme", "exit 127");
      expect((await tester().test("acme-keys")).failure).toMatchObject({ reason: "tool-missing" });
    });

    it("ssh: exit 255 is an unreachable host, another exit a refused command, none a timeout", async () => {
      await service.create(
        { org: "acme", id: "acme-box", type: "ssh", name: "Box", fields: { alias: "acme-prod" } },
        "connections.create",
        OWNER,
      );
      const withCode = (code: number | null) =>
        new ConnectionTester({
          connections: service,
          secrets,
          spawner: localSpawner,
          base: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          scratchRoot: async () => scratchRoot,
          hostHome: dir,
          ssh: async (): Promise<SshRun> => ({ code, output: "Permission denied (publickey)" }),
        });
      expect((await withCode(255).test("acme-box")).failure?.reason).toBe("unreachable");
      expect((await withCode(1).test("acme-box")).failure?.reason).toBe("unexpected");
      expect((await withCode(null).test("acme-box")).failure?.reason).toBe("timeout");
    });

    it("a remote MCP server's HTTP status is the reason: 401 is rejected, 503 is service-down", async () => {
      const answer = { status: 401 };
      const server = createServer((_req, res) => {
        res.writeHead(answer.status).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        await service.create(
          {
            org: "acme",
            id: "acme-remote",
            type: "mcp",
            name: "Remote",
            fields: { url: `http://127.0.0.1:${port}/mcp` },
          },
          "connections.create",
          OWNER,
        );
        expect((await tester().test("acme-remote")).failure?.reason).toBe("rejected");
        answer.status = 503;
        expect((await tester().test("acme-remote")).failure?.reason).toBe("service-down");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

  });

});
