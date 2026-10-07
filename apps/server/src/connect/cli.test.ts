import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CliCheckResult, CliLoginResult, CliToolId, CommandMeta, ConnectionConfig } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { runConnections } from "../connections/access.ts";
import { planConnections } from "../connections/plan.ts";
import { connectionDir } from "../connections/service.ts";
import { generateKey, SecretStore } from "../secrets/store.ts";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { AppClientStore } from "./app-client.ts";
import type { CliHost } from "./cli-connect.ts";
import { GrantStore } from "./grant.ts";
import { ConnectService } from "./service.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };

interface FakeHost extends CliHost {
  logins: { signIn: string; tool: CliToolId; connection: string; expected?: string }[];
  cancelled: string[];
  logouts: { tool: CliToolId; connection: string }[];
  online: boolean;
  /** What the next login does. */
  next: (
    params: FakeHost["logins"][number],
    onPage: Parameters<CliHost["login"]>[1],
  ) => Promise<CliLoginResult>;
  checkResult: CliCheckResult;
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    logins: [],
    cancelled: [],
    logouts: [],
    online: true,
    checkResult: { ok: true, identity: "ops@acme.example", detail: "Signed in." },
    next: async () => ({ state: "done", identity: "ops@acme.example" }),
    connected: () => host.online,
    login: async (params, onPage) => {
      host.logins.push(params);
      return host.next(params, onPage);
    },
    cancel: async (signIn) => {
      host.cancelled.push(signIn);
    },
    check: async () => host.checkResult,
    logout: async (params) => {
      host.logouts.push(params);
      return { revoked: true };
    },
  };
  return host;
}

interface Rig {
  connect: ConnectService;
  host: FakeHost;
  connections: Map<string, { org: string; connection: ConnectionConfig }>;
  logs: string[];
  opened: string[];
  skip(ms: number): void;
  cleanup(): Promise<void>;
}

async function rig(): Promise<Rig> {
  const { dir, cleanup } = await tempDir();
  const keyFile = join(dir, "secrets.key");
  await writeKeyFile(keyFile, await generateKey());
  await mkdir(join(dir, "home"));
  const secrets = new SecretStore(join(dir, "home"), keyFile);
  const host = fakeHost();
  const connections = new Map<string, { org: string; connection: ConnectionConfig }>();
  const logs: string[] = [];
  const opened: string[] = [];
  let offset = 0;
  const connect = new ConnectService({
    grants: new GrantStore(secrets),
    apps: new AppClientStore(secrets),
    orgName: async (org) => org,
    secretOf: async () => undefined,
    cli: host,
    connections: {
      async create(input) {
        connections.set(input.id ?? input.name, {
          org: input.org,
          connection: { type: input.type, name: input.name, fields: input.fields } as ConnectionConfig,
        });
      },
      async remove(id) {
        connections.delete(id);
      },
      async find(id) {
        return connections.get(id);
      },
    },
    connectionIds: async () => [...connections].map(([id, c]) => ({ id, ...c })),
    orgExists: async (org) => ["acme", "globex"].includes(org),
    redirect: "http://127.0.0.1:7070/oauth/callback",
    openUrl: async (url) => {
      opened.push(url);
      return true;
    },
    helperConnected: () => host.online,
    changed: () => undefined,
    listTools: async () => [],
    now: () => new Date(Date.now() + offset),
    log: (line) => logs.push(line),
  });
  return {
    connect,
    host,
    connections,
    logs,
    opened,
    skip: (ms) => {
      offset += ms;
    },
    cleanup,
  };
}

const until = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let r: Rig;
afterEach(async () => {
  await r?.cleanup();
});

describe("a command-line tool's sign-in", () => {
  it("shows only a safe sentence when the tool's login fails", async () => {
    r = await rig();
    r.host.next = async () => {
      throw new Error("The Cloudflare (vercel) sign-in ran out of time. Nothing was saved.");
    };
    const view = await r.connect.start({ org: "acme", service: "vercel-cli", access: "read" }, OWNER);
    await until(() => r.connect.flow(view.flow).state === "failed");
    expect(r.connections.size).toBe(0);
  });

  it("refuses a reconnect as another account and leaves the connection as it was", async () => {
    r = await rig();
    const first = await r.connect.start({ org: "acme", service: "vercel-cli", access: "read" }, OWNER);
    await until(() => r.connect.flow(first.flow).state === "connected");
    const id = r.connect.flow(first.flow).connection ?? "";
    r.host.next = async () => ({ state: "other-account", identity: "intruder@other.example" });
    const again = await r.connect.start(
      { org: "acme", service: "vercel-cli", access: "read", connection: id },
      OWNER,
    );
    await until(() => r.connect.flow(again.flow).state === "failed");
    expect(r.connect.flow(again.flow).message).toContain("intruder@other.example");
    expect(r.host.logins.at(-1)?.expected).toBe("ops@acme.example");
    expect(r.connections.get(id)?.connection.fields?.account).toBe("ops@acme.example");
  });

  it("cancel stops the tool on the helper and saves nothing", async () => {
    r = await rig();
    r.host.next = () => new Promise(() => undefined);
    const view = await r.connect.start({ org: "acme", service: "stripe-cli", access: "read" }, OWNER);
    r.connect.cancel(view.flow);
    expect(r.connect.flow(view.flow).state).toBe("cancelled");
    await until(() => r.host.cancelled.length === 1);
    expect(r.host.cancelled[0]).toBe(r.host.logins[0]?.signIn);
    expect(r.connections.size).toBe(0);
  });

  it("a login that hangs ends as expired, tells the helper to stop and saves nothing", async () => {
    r = await rig();
    r.host.next = () => new Promise(() => undefined);
    const view = await r.connect.start({ org: "acme", service: "gcloud", access: "read" }, OWNER);
    r.skip(16 * 60_000);
    expect(r.connect.flow(view.flow).state).toBe("expired");
    await until(() => r.host.cancelled.length === 1);
    expect(r.connections.size).toBe(0);
  });

  it("signs two workspaces in to the same tool as different accounts, each in its own folder", async () => {
    r = await rig();
    r.host.next = async (p) => ({
      state: "done",
      identity: p.connection.startsWith("vercel-cli-") ? "dev@globex.example" : "ops@acme.example",
    });
    const a = await r.connect.start({ org: "acme", service: "vercel-cli", access: "read" }, OWNER);
    await until(() => r.connect.flow(a.flow).state === "connected");
    const b = await r.connect.start({ org: "globex", service: "vercel-cli", access: "read" }, OWNER);
    await until(() => r.connect.flow(b.flow).state === "connected");
    const idA = r.connect.flow(a.flow).connection ?? "";
    const idB = r.connect.flow(b.flow).connection ?? "";
    expect(idA).not.toBe(idB);
    expect(r.host.logins.map((l) => l.connection)).toEqual([idA, idB]);
    expect(r.connections.get(idA)?.connection.fields?.account).toBe("ops@acme.example");
    expect(r.connections.get(idB)?.connection.fields?.account).toBe("dev@globex.example");
    // Disconnecting one leaves the other.
    await r.connect.disconnect(idA, OWNER);
    expect(r.connections.has(idB)).toBe(true);
    expect(r.host.logouts.map((l) => l.connection)).toEqual([idA]);
  });
});

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

  it("gives a run in workspace B B's folder and never A's", async () => {
    const held = runConnections({
      agent: { id: "globex-dev", scope: "globex" },
      task: { org: "globex", connections: [] },
      orgs,
    });
    expect(held.map((h) => h.id)).toEqual(["vercel-2"]);
    const plan = await planConnections(held, "/run", deps());
    expect(plan.profiles).toEqual([`${home}/connections/vercel-2/profile`]);
    expect(JSON.stringify(plan)).not.toContain("connections/vercel/");
    expect(JSON.stringify(plan)).not.toContain("connections/aws");
  });

  it("an agent of workspace A in a task of workspace B gets nothing", () => {
    expect(
      runConnections({
        agent: { id: "acme-dev", scope: "acme" },
        task: { org: "globex", connections: [] },
        orgs,
      }),
    ).toEqual([]);
  });
});
