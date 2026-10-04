import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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

/** Answers initialize and tools/list over stdio, like any MCP server. */
const FAKE_MCP_SERVER = `const rl = require("node:readline").createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  else if (msg.method === "tools/list") reply(msg.id, { tools: [{ name: "query_logs", inputSchema: { type: "object" } }, { name: "list_alerts", inputSchema: { type: "object" } }] });
});
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
    await writeFile(join(dir, "fake-mcp.cjs"), FAKE_MCP_SERVER);
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
        browserCommand: () => ({ command: "node", args: [join(dir, "fake-mcp.cjs")] }),
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
    expect(result.detail).toBe("kubectl reads context prod, namespace api: 2 permission rules.");
    expect(result.warnings).toEqual([
      "This identity can delete pods. Use a read-only one, like a viewer role.",
    ]);
    const copy = await readFile(`${seen}-kubeconfig`, "utf8");
    expect(copy).toContain("namespace: api");
    expect(copy).not.toContain(STAGING_TOKEN);
    const env = await readFile(`${seen}-env`, "utf8");
    expect(env).not.toContain("MAJHI_TEST_CANARY");
    expect(env).toContain(`HOME=${scratchRoot}/test-`);
    expect(await readdir(scratchRoot)).toEqual([]);
    expect((await service.get("acme-prod")).lastTest?.ok).toBe(true);
  });

  it("says when kubectl is not installed where agents run", async () => {
    await kubectl();
    const result = await tester(bin).test("acme-prod");
    expect(result).toMatchObject({ ok: false, detail: "kubectl is not installed where agents run." });
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
    expect(result.detail).toBe(
      'acme whoami "$REGION" works: signed in with [secret acme-keys.API_KEY] in eu-west-1',
    );
    expect(JSON.stringify(await service.get("acme-keys"))).not.toContain(API_KEY);
  });

  it("lists the tools of a local MCP server and of a browser server", async () => {
    await service.create(
      {
        org: "acme",
        id: "acme-logs",
        type: "mcp",
        name: "Logs",
        fields: { transport: "local", command: `node ${join(dir, "fake-mcp.cjs")}` },
      },
      "connections.create",
      OWNER,
    );
    expect(await tester().test("acme-logs")).toMatchObject({
      ok: true,
      detail: "2 tools: query_logs, list_alerts.",
    });
    await service.create(
      { org: "acme", id: "acme-web", type: "browser", name: "Web" },
      "connections.create",
      OWNER,
    );
    expect((await tester().test("acme-web")).detail).toBe(
      "Playwright MCP starts. 2 tools: query_logs, list_alerts.",
    );
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  describe("a remote MCP server", () => {
    let server: Server;
    let keys: (string | undefined)[];

    beforeEach(async () => {
      keys = [];
      server = createServer((req, res) => {
        keys.push(req.headers["api-key"] as string | undefined);
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const msg = JSON.parse(body) as {
            id?: number;
            method: string;
            params?: { protocolVersion?: string };
          };
          if (msg.id === undefined) {
            res.writeHead(202).end();
            return;
          }
          const result =
            msg.method === "initialize"
              ? {
                  protocolVersion: msg.params?.protocolVersion,
                  capabilities: { tools: {} },
                  serverInfo: { name: "nr", version: "1" },
                }
              : { tools: [{ name: "execute_nrql_query", inputSchema: { type: "object" } }] };
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    });
    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("sends the secret header and lists the tools", async () => {
      const port = (server.address() as AddressInfo).port;
      await service.create(
        {
          org: "acme",
          id: "acme-newrelic",
          type: "mcp",
          name: "New Relic",
          fields: { url: `http://127.0.0.1:${port}/mcp` },
          headers: { "Api-Key": { kind: "secret" } },
        },
        "connections.create",
        OWNER,
      );
      await service.setSecret(
        { id: "acme-newrelic", field: "Api-Key", list: "headers", value: API_KEY },
        "connections.setSecret",
        OWNER,
      );
      const result = await tester().test("acme-newrelic");
      expect(result).toMatchObject({ ok: true, detail: "1 tool: execute_nrql_query." });
      expect(keys.filter((k) => k !== undefined).every((k) => k === API_KEY)).toBe(true);
      expect(keys).toContain(API_KEY);
    });
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
    expect(await tester().test("acme-box")).toMatchObject({
      ok: false,
      detail: "~/.ssh/config has no Host acme-staging. Use user@address, like root@203.0.113.10.",
    });
    expect(sshCalls).toHaveLength(1);
  });

  it("does not run what is not set yet", async () => {
    await service.create(
      { org: "acme", id: "acme-mail", type: "mail", name: "Mail" },
      "connections.create",
      OWNER,
    );
    expect(await tester().test("acme-mail")).toMatchObject({
      ok: false,
      detail: "IMAP host is not set. User is not set. Password is not set.",
    });
  });
});
