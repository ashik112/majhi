import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommandMeta, ConnectionConfig, ConnectionHealth, ConnectionTestResult } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionHealthService } from "../connections/health.ts";
import { generateKey, SecretStore } from "../secrets/store.ts";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { AppClientStore } from "./app-client.ts";
import { GrantStore } from "./grant.ts";
import { ConnectService } from "./service.ts";
import { FakeProvider, fakeProviderService } from "./testing/provider-fake.ts";

/**
 * "Connected" means a real call passed. These drive a provider sign-in (the shape Gmail, Calendar and
 * Drive have) against a fake provider and read what the owner would see: the flow's end and the
 * connection's one state. Google's setup steps are checked the way the page checks them: by what the
 * token answer and the API answer say, never by their words.
 */

const OWNER: CommandMeta = { actor: { kind: "owner" } };
const REDIRECT = "http://127.0.0.1:7070/oauth/callback";
const ACTIVATION = "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123";

class MemoryRepo {
  readonly rows = new Map<string, ConnectionHealth>();
  get(id: string) {
    return this.rows.get(id);
  }
  all() {
    return new Map(this.rows);
  }
  set(id: string, health: ConnectionHealth) {
    this.rows.set(id, health);
  }
  delete(id: string) {
    this.rows.delete(id);
  }
}

interface Rig {
  connect: ConnectService;
  health: ConnectionHealthService;
  provider: FakeProvider;
  connections: Map<string, { org: string; connection: ConnectionConfig }>;
  logs: string[];
  page: () => string;
  cleanup(): Promise<void>;
}

async function rig(options: { provider?: ConstructorParameters<typeof FakeProvider>[0] } = {}): Promise<Rig> {
  const { dir, cleanup } = await tempDir();
  const keyFile = join(dir, "secrets.key");
  await writeKeyFile(keyFile, await generateKey());
  await mkdir(join(dir, "home"));
  const secrets = new SecretStore(join(dir, "home"), keyFile);
  const provider = new FakeProvider(options.provider);
  await provider.start();
  const apps = new AppClientStore(secrets);
  await apps.save({ v: 1, app: "fakeapp", org: "acme", clientId: "client-acme-123" });
  const connections = new Map<string, { org: string; connection: ConnectionConfig }>();
  const logs: string[] = [];
  let page = "";
  let connect: ConnectService;
  const health = new ConnectionHealthService({
    repo: new MemoryRepo(),
    list: async () => [...connections].map(([id, c]) => ({ id, org: c.org, name: c.connection.name })),
    // The same shape as the connection tester: the check, then the state follows its result.
    check: async (id): Promise<ConnectionTestResult> => {
      const result = await connect.test(id);
      health.observe(id, result);
      return result;
    },
    changed: () => undefined,
    gap: async () => undefined,
  });
  connect = new ConnectService({
    grants: new GrantStore(secrets),
    apps,
    orgName: async (org) => org,
    secretOf: async () => undefined,
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
    orgExists: async (org) => org === "acme",
    redirect: REDIRECT,
    openUrl: async (url) => {
      page = url;
      return true;
    },
    helperConnected: () => true,
    changed: () => undefined,
    listTools: async () => [],
    catalog: [fakeProviderService(provider.url)],
    health,
    log: (line) => logs.push(line),
  });
  return {
    connect,
    health,
    provider,
    connections,
    logs,
    page: () => page,
    cleanup: async () => {
      connect.stop();
      await provider.stop();
      await cleanup();
    },
  };
}

/** Starts a sign-in, has the owner approve it, and returns the flow as it ends. */
async function signIn(r: Rig, connection?: string) {
  const view = await r.connect.start(
    { org: "acme", service: "fakeapi", access: "read", ...(connection === undefined ? {} : { connection }) },
    OWNER,
  );
  await r.connect.callback(r.provider.approve(r.page()));
  return r.connect.flow(view.flow);
}

let r: Rig;
afterEach(async () => {
  await r?.cleanup();
});

describe("connected means a real call passed", () => {
  it("a sign-in whose check passes ends connected, and the connection says when and what was checked", async () => {
    r = await rig();
    const flow = await signIn(r);
    expect(flow.state).toBe("connected");
    const id = flow.connection ?? "";
    expect(r.health.get(id)).toMatchObject({
      state: "connected",
      account: "maria@acme.example",
    });
    const state = r.health.get(id);
    expect(state?.state === "connected" && state.checked.join(" ")).toContain("Fake API");
    // Nothing a service issued is in the state, the flow or the log.
    const everything = JSON.stringify(state) + JSON.stringify(flow) + r.logs.join("\n");
    for (const secret of r.provider.secretsSeen()) expect(everything).not.toContain(secret);
  });

  it("a sign-in the service accepts but whose check fails is failed, with a typed reason and the fix, and the connection stays", async () => {
    r = await rig();
    // The token works at the token endpoint, and the API then refuses it.
    r.provider.apiDisabled = {};
    const flow = await signIn(r);
    expect(flow.state).toBe("failed");
    expect(flow.message).toContain("check failed");
    const id = flow.connection ?? [...r.connections.keys()][0] ?? "";
    expect(r.connections.has(id)).toBe(true);
    expect(r.health.get(id)).toMatchObject({ state: "failed", reason: "setup-needed", status: 403 });
  });

  it("a service that no longer accepts the renewal makes a working connection need attention, and says to sign in again", async () => {
    r = await rig();
    const flow = await signIn(r);
    const id = flow.connection ?? "";
    r.provider.revokeAll();
    r.provider.failRefresh = "invalid_grant";
    const result = await r.health.check(id);
    expect(result.failure).toMatchObject({ reason: "expired" });
    // It worked before, so it needs attention rather than being a failed connect.
    expect(r.health.get(id)).toMatchObject({ state: "needs-attention", reason: "expired" });
  });

  it("a re-check that passes again heals needs-attention", async () => {
    r = await rig();
    const flow = await signIn(r);
    const id = flow.connection ?? "";
    r.provider.apiDisabled = { activationUrl: ACTIVATION };
    await r.health.check(id);
    expect(r.health.get(id)?.state).toBe("needs-attention");
    r.provider.apiDisabled = undefined;
    await r.health.check(id);
    expect(r.health.get(id)?.state).toBe("connected");
  });
});

describe("the Google setup steps check themselves", () => {
  it("API enabled: a link that is not Google's own is never offered", async () => {
    r = await rig();
    const flow = await signIn(r);
    const id = flow.connection ?? "";
    r.provider.apiDisabled = { activationUrl: "https://evil.example/enable?x=1" };
    await r.health.check(id);
    const state = r.health.get(id);
    expect(state).toMatchObject({ reason: "setup-needed" });
    expect(state?.state === "needs-attention" && state.fixUrl).toBeFalsy();
  });

  it("published: a refresh token that ends in 7 days is an app in Testing, and fails the check with the publish page", async () => {
    r = await rig({ provider: { refreshExpiresIn: 604_799 } });
    const flow = await signIn(r);
    expect(flow.state).toBe("failed");
    const id = flow.connection ?? "";
    expect(r.health.get(id)).toMatchObject({
      state: "failed",
      reason: "app-in-testing",
      fixUrl: "https://console.cloud.google.com/auth/audience",
    });
  });
});
