import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommandMeta, ConnectionConfig, ServiceEntry } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKey, SecretStore } from "../secrets/store.ts";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { AppClientStore } from "./app-client.ts";
import { GrantStore } from "./grant.ts";
import { ConnectService } from "./service.ts";
import { FakeProvider, fakeProviderService } from "./testing/provider-fake.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };
const REDIRECT = "http://127.0.0.1:7070/oauth/callback";

interface Rig {
  connect: ConnectService;
  provider: FakeProvider;
  secrets: SecretStore;
  apps: AppClientStore;
  connections: Map<string, { org: string; connection: ConnectionConfig }>;
  logs: string[];
  waits: number[];
  skip(ms: number): void;
  cleanup(): Promise<void>;
}

async function rig(
  options: {
    flow?: "loopback" | "device";
    secret?: string;
    provider?: ConstructorParameters<typeof FakeProvider>[0];
    entry?: (base: string) => ServiceEntry;
    noApp?: boolean;
  } = {},
): Promise<Rig> {
  const { dir, cleanup } = await tempDir();
  const keyFile = join(dir, "secrets.key");
  await writeKeyFile(keyFile, await generateKey());
  await mkdir(join(dir, "home"));
  const secrets = new SecretStore(join(dir, "home"), keyFile);
  const provider = new FakeProvider({
    ...(options.secret === undefined ? {} : { requireSecret: options.secret }),
    ...options.provider,
  });
  await provider.start();
  const apps = new AppClientStore(secrets);
  if (options.noApp !== true) {
    await apps.save({
      v: 1,
      app: "fakeapp",
      org: "acme",
      clientId: "client-acme-123",
      ...(options.secret === undefined ? {} : { clientSecret: options.secret }),
    });
  }
  const connections = new Map<string, { org: string; connection: ConnectionConfig }>();
  const logs: string[] = [];
  const waits: number[] = [];
  let offset = 0;
  const entry =
    options.entry?.(provider.url) ??
    fakeProviderService(provider.url, {
      flow: options.flow ?? "loopback",
      provider: options.secret === undefined ? {} : { clientAuth: "secret" },
    });
  const connect = new ConnectService({
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
    orgExists: async (org) => ["acme", "globex"].includes(org),
    redirect: REDIRECT,
    openUrl: async () => true,
    helperConnected: () => true,
    changed: () => undefined,
    listTools: async () => [],
    catalog: [entry],
    now: () => new Date(Date.now() + offset),
    wait: async (ms) => {
      waits.push(ms);
    },
    log: (line) => logs.push(line),
  });
  return {
    connect,
    provider,
    secrets,
    apps,
    connections,
    logs,
    waits,
    skip: (ms) => {
      offset += ms;
    },
    cleanup: async () => {
      connect.stop();
      await provider.stop();
      await cleanup();
    },
  };
}

/** The page majhi opened, from the flow's own link (the helper is offline in these tests). */
async function begin(r: Rig, o: { access?: "read" | "readwrite" | "send"; org?: string } = {}) {
  // The rig's helper is "connected", so the link is hidden; read it from the open call instead.
  let page = "";
  const connect = new ConnectService({
    ...(r.connect as unknown as { deps: ConstructorParameters<typeof ConnectService>[0] }).deps,
    openUrl: async (url) => {
      page = url;
      return true;
    },
  });
  const view = await connect.start(
    { org: o.org ?? "acme", service: "fakeapi", access: o.access ?? "read" },
    OWNER,
  );
  return { connect, view, page };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let r: Rig;
afterEach(async () => {
  await r?.cleanup();
});

describe("a provider's own OAuth with PKCE and a loopback redirect", () => {
  beforeEach(async () => {
    r = await rig();
  });

  it("asks for the page with PKCE S256, the state, the redirect and only the read scopes", async () => {
    const { page } = await begin(r);
    const url = new URL(page);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")?.length).toBeGreaterThan(30);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("client_id")).toBe("client-acme-123");
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(["mail.read", "openid"]);
    expect(url.searchParams.get("resource")).toBeNull();
    expect(page).not.toContain("secret");
  });

  it("connects: makes the connection, who signed in, the plain scopes, and no token in view or logs", async () => {
    const { connect, view, page } = await begin(r);
    const back = r.provider.approve(page, { account: "maria@acme.example" });
    const result = await connect.callback(back);
    expect(result.ok).toBe(true);
    const done = connect.flow(view.flow);
    expect(done.state).toBe("connected");
    expect(done.account).toBe("maria@acme.example");
    expect(done.test?.ok).toBe(true);
    expect(done.scopes.map((s) => s.sentence)).toEqual(["Read mail."]);
    const made = [...r.connections.values()][0];
    expect(made?.connection.type).toBe("api");
    expect(made?.connection.fields).toMatchObject({
      service: "fakeapi",
      auth: "oauth",
      token_var: "FAKE_API_TOKEN",
    });
    const bearer = await connect.bearer([...r.connections.keys()][0] ?? "");
    expect("token" in bearer).toBe(true);
    const seen = r.provider.secretsSeen();
    const everything = JSON.stringify(done) + r.logs.join("\n") + JSON.stringify(await connect.status());
    for (const secret of seen) expect(everything).not.toContain(secret);
  });

  it("refuses a code redeemed with a verifier that does not match the challenge", async () => {
    r.provider.swapChallenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const { connect, view, page } = await begin(r);
    const result = await connect.callback(r.provider.approve(page));
    expect(result.ok).toBe(false);
    expect(connect.flow(view.flow).state).toBe("failed");
    expect(r.connections.size).toBe(0);
    expect(await r.secrets.names()).not.toContainEqual(expect.stringMatching(/^oauth-/));
  });

  it("refuses an answer from another issuer before it redeems anything", async () => {
    r = await rig({
      entry: (base) =>
        fakeProviderService(base, { provider: { issuer: "https://login.acme.example", issSent: true } }),
    });
    const { connect, page } = await begin(r);
    const result = await connect.callback(r.provider.approve(page, { iss: "https://evil.example" }));
    expect(result.ok).toBe(false);
    expect(r.provider.tokenCalls).toBe(0);
    expect(r.connections.size).toBe(0);
  });

  it("refuses an answer with no issuer from a provider that always sends one", async () => {
    r = await rig({
      entry: (base) =>
        fakeProviderService(base, { provider: { issuer: "https://login.acme.example", issSent: true } }),
    });
    const { connect, page } = await begin(r);
    const result = await connect.callback(r.provider.approve(page, { iss: null }));
    expect(result.ok).toBe(false);
    expect(r.provider.tokenCalls).toBe(0);
  });

  it("takes a state once, and not after it expired", async () => {
    const { connect, page } = await begin(r);
    const back = r.provider.approve(page);
    expect((await connect.callback(back)).ok).toBe(true);
    expect((await connect.callback(back)).ok).toBe(false);
    expect(r.provider.tokenCalls).toBe(1);
  });

  it("uses a workspace's own app and never another workspace's", async () => {
    await expect(
      r.connect.start({ org: "globex", service: "fakeapi", access: "read" }, OWNER),
    ).rejects.toThrow("Set up the Fake API app first");
  });

  it("renews with one request when several callers ask, saves the new refresh token, and ends on a refused renewal", async () => {
    const { connect, page } = await begin(r, { org: "acme" });
    await connect.callback(r.provider.approve(page));
    const id = [...r.connections.keys()][0] ?? "";
    r.skip(3600 * 1000 - 60_000);
    r.provider.hold();
    const calls = [connect.bearer(id), connect.bearer(id), connect.bearer(id)];
    await until(() => r.provider.refreshCalls >= 1);
    r.provider.release();
    const answers = await Promise.all(calls);
    expect(r.provider.refreshCalls).toBe(1);
    expect(answers.every((a) => "token" in a)).toBe(true);
    // The renewed token is the one saved.
    const saved = await new GrantStore(r.secrets).get(id);
    expect((answers[0] as { token?: string }).token).toBe(saved?.tokens.accessToken);

    r.skip(3600 * 1000);
    r.provider.failRefresh = "invalid_grant";
    const refused = await connect.bearer(id);
    expect("problem" in refused).toBe(true);
    expect((await connect.status())[0]?.state).toBe("needs-reconnect");
  });
});

describe("a provider that needs the owner's client secret", () => {
  it("sends the secret only in the token request body, never in the page address or a log", async () => {
    r = await rig({ secret: "sekret-client-value-0001" });
    const { connect, page } = await begin(r);
    expect(page).not.toContain("sekret-client-value-0001");
    await connect.callback(r.provider.approve(page));
    expect(r.provider.lastTokenBody?.get("client_secret")).toBe("sekret-client-value-0001");
    expect(r.logs.join("\n")).not.toContain("sekret-client-value-0001");
    const id = [...r.connections.keys()][0] ?? "";
    // The grant holds no client secret: it stays with the app.
    expect(JSON.stringify(await new GrantStore(r.secrets).get(id))).not.toContain("sekret-client-value-0001");
    // Renewal and revoke use it too.
    r.skip(3600 * 1000);
    expect("token" in (await connect.bearer(id))).toBe(true);
    expect(r.provider.lastTokenBody?.get("client_secret")).toBe("sekret-client-value-0001");
    await connect.disconnect(id, OWNER);
    expect(r.provider.revoked.some((x) => x.clientSecret === "sekret-client-value-0001")).toBe(true);
  });
});

describe("the device grant", () => {
  it("shows the code and the page, waits through pending answers and connects", async () => {
    r = await rig({ flow: "device", provider: { deviceScript: ["pending", "pending", "ok"] } });
    const view = await r.connect.start({ org: "acme", service: "fakeapi", access: "read" }, OWNER);
    expect(view.code).toBe("WDJB-MJHT");
    expect(view.message).toContain("WDJB-MJHT");
    await until(() => r.connect.flow(view.flow).state === "connected");
    const done = r.connect.flow(view.flow);
    expect(done.account).toBe("maria@acme.example");
    expect(done.code).toBeUndefined();
    expect(r.provider.tokenCalls).toBe(3);
    const everything = JSON.stringify(done) + r.logs.join("\n");
    for (const secret of r.provider.secretsSeen()) expect(everything).not.toContain(secret);
    expect(everything).not.toContain("WDJB-MJHT");
  });
});
