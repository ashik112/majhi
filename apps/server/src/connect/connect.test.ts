import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommandMeta, ConnectionConfig } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listTools, remoteTransport } from "../connections/mcp-client.ts";
import { generateKey, SecretStore } from "../secrets/store.ts";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { until } from "../testing/until.ts";
import { AppClientStore } from "./app-client.ts";
import { GrantStore } from "./grant.ts";
import { ConnectService, FLOW_TTL_MS } from "./service.ts";
import { FakeAuthServer, FakeMcpServer, fakeService } from "./testing/fakes.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };
const REDIRECT = "http://127.0.0.1:7070/oauth/callback";

interface Rig {
  connect: ConnectService;
  grants: GrantStore;
  secrets: SecretStore;
  auth: FakeAuthServer;
  mcp: FakeMcpServer;
  connections: Map<string, { org: string; connection: ConnectionConfig }>;
  logs: string[];
  attention: { org: string; key: string; title: string; detail: string }[];
  opened: string[];
  remounted: string[];
  /** Moves the service's clock forward. */
  skip(ms: number): void;
  /** A second service over the same store, like a restart. */
  again(): ConnectService;
  /** Starts, approves as `account` and finishes the callback; returns the flow view after it. */
  connectAs(
    account: string,
    options?: {
      org?: string;
      connection?: string;
      access?: "read" | "readwrite";
      scope?: string[];
      name?: string;
      products?: string[];
    },
  ): Promise<Awaited<ReturnType<ConnectService["flow"]>>>;
  /** Starts a flow and returns the owner's redirect without calling back. */
  begin(
    account: string,
    options?: { org?: string; connection?: string; access?: "read" | "readwrite"; deny?: boolean },
  ): Promise<{ flow: string; back: URLSearchParams; url: string }>;
  cleanup(): Promise<void>;
}

async function rig(
  options: {
    auth?: ConstructorParameters<typeof FakeAuthServer>[0];
    requiredScope?: string;
    originResource?: boolean;
    helper?: boolean;
    cimdUrl?: string;
    /** Products of the fake service, each at the fake server's address with its own query. */
    products?: string[];
  } = {},
): Promise<Rig> {
  const { dir, cleanup } = await tempDir();
  const keyFile = join(dir, "secrets.key");
  await writeKeyFile(keyFile, await generateKey());
  await mkdir(join(dir, "home"));
  const secrets = new SecretStore(join(dir, "home"), keyFile);
  const grants = new GrantStore(secrets);
  const auth = new FakeAuthServer(options.auth);
  await auth.start();
  const mcp = new FakeMcpServer(auth, {
    ...(options.requiredScope === undefined ? {} : { requiredScope: options.requiredScope }),
    ...(options.originResource === undefined ? {} : { originResource: options.originResource }),
  });
  await mcp.start();
  const connections = new Map<string, { org: string; connection: ConnectionConfig }>();
  const logs: string[] = [];
  const attention: Rig["attention"] = [];
  const opened: string[] = [];
  const remounted: string[] = [];
  let offset = 0;
  const make = () =>
    new ConnectService({
      grants,
      apps: new AppClientStore(secrets),
      orgName: async (org) => org,
      secretOf: async () => undefined,
      connections: {
        async create(input) {
          connections.set(input.id ?? input.name, {
            org: input.org,
            connection: { type: "mcp", name: input.name, fields: input.fields } as ConnectionConfig,
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
      ...(options.cimdUrl === undefined ? {} : { clientMetadataUrl: options.cimdUrl }),
      openUrl: async (url) => {
        opened.push(url);
        return true;
      },
      helperConnected: () => options.helper === true,
      changed: () => undefined,
      listTools: (url, token) =>
        listTools(remoteTransport(url, { Authorization: `Bearer ${token}` }), 10_000),
      catalog: [
        fakeService(
          mcp.url,
          options.products === undefined
            ? {}
            : {
                products: options.products.map((id) => ({
                  id,
                  name: id.toUpperCase(),
                  mcpUrl: `${mcp.url}?product=${id}`,
                })),
              },
        ),
      ],
      now: () => new Date(Date.now() + offset),
      attention: (item) => attention.push(item),
      remount: (id) => remounted.push(id),
      inUse: () => true,
      log: (line) => logs.push(line),
    });
  const connect = make();
  const r: Rig = {
    connect,
    grants,
    secrets,
    auth,
    mcp,
    connections,
    logs,
    attention,
    opened,
    remounted,
    skip: (ms) => {
      offset += ms;
    },
    again: make,
    async begin(account, o = {}) {
      const flow = await connect.start(
        {
          org: o.org ?? "acme",
          service: "fakesvc",
          access: o.access ?? "read",
          ...(o.connection === undefined ? {} : { connection: o.connection }),
        },
        OWNER,
      );
      const url = flow.url ?? opened.at(-1) ?? "";
      const back = new URL(auth.approve(url, { account, ...(o.deny === true ? { deny: true } : {}) }))
        .searchParams;
      return { flow: flow.flow, back, url };
    },
    async connectAs(account, o = {}) {
      const flow = await connect.start(
        {
          org: o.org ?? "acme",
          service: "fakesvc",
          access: o.access ?? "read",
          ...(o.connection === undefined ? {} : { connection: o.connection }),
          ...(o.name === undefined ? {} : { name: o.name }),
          ...(o.products === undefined ? {} : { products: o.products }),
        },
        OWNER,
      );
      const url = flow.url ?? opened.at(-1) ?? "";
      const back = new URL(
        auth.approve(url, { account, ...(o.scope === undefined ? {} : { scope: o.scope }) }),
      );
      await connect.callback(back.searchParams);
      return connect.flow(flow.flow);
    },
    async cleanup() {
      connect.stop();
      await auth.stop();
      await mcp.stop();
      await cleanup();
    },
  };
  return r;
}

describe("connecting a remote MCP server with OAuth", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(() => r.cleanup());

  it("refuses a state it did not issue, and the real answer still works afterwards", async () => {
    const { flow, back } = await r.begin("maria@acme.example");
    const forged = new URLSearchParams(back);
    forged.set("state", "not-the-state");
    const result = await r.connect.callback(forged);
    expect(result.ok).toBe(false);
    expect(r.connections.size).toBe(0);
    expect(r.connect.flow(flow).state).toBe("waiting");
    expect((await r.connect.callback(back)).ok).toBe(true);
    expect(r.connect.flow(flow).state).toBe("connected");
  });

  it("refuses a replayed answer: the state works once", async () => {
    const { back } = await r.begin("maria@acme.example");
    expect((await r.connect.callback(back)).ok).toBe(true);
    const first = (await r.grants.get("fakesvc"))?.tokens.accessToken;
    const replay = await r.connect.callback(back);
    expect(replay.ok).toBe(false);
    expect((await r.grants.get("fakesvc"))?.tokens.accessToken).toBe(first);
  });

  it("an answer for one workspace's attempt cannot complete another's", async () => {
    // Two attempts for two workspaces at the same service.
    const a = await r.begin("maria@acme.example", { org: "acme" });
    const b = await r.begin("bob@globex.example", { org: "globex" });
    // Acme's code under Globex's state: the code was made for Acme's PKCE challenge.
    const mixed = new URLSearchParams(a.back);
    mixed.set("state", b.back.get("state") ?? "");
    const result = await r.connect.callback(mixed);
    expect(result.ok).toBe(false);
    expect(r.connect.flow(b.flow).state).toBe("failed");
    expect(r.connections.has("fakesvc-2")).toBe(false);
    // The service burned the code when it saw it presented with the wrong verifier.
    expect((await r.connect.callback(a.back)).ok).toBe(false);
    expect(r.connections.size).toBe(0);
    expect(await r.grants.connections()).toEqual([]);
  });

  it("refuses an answer after the page timed out", async () => {
    const { flow, back } = await r.begin("maria@acme.example");
    r.skip(FLOW_TTL_MS + 1000);
    const result = await r.connect.callback(back);
    expect(result.ok).toBe(false);
    expect(r.connect.flow(flow).state).toBe("expired");
    expect(r.connections.size).toBe(0);
  });

  it("refuses an answer that names another issuer", async () => {
    const { back } = await r.begin("maria@acme.example");
    const odd = new URLSearchParams(back);
    odd.set("iss", "https://evil.example");
    expect((await r.connect.callback(odd)).ok).toBe(false);
    expect(r.connections.size).toBe(0);
  });

  it("cancel stops waiting and a late answer is refused", async () => {
    const { flow, back } = await r.begin("maria@acme.example");
    expect(r.connect.cancel(flow).state).toBe("cancelled");
    expect((await r.connect.callback(back)).ok).toBe(false);
    expect(r.connections.size).toBe(0);
  });

  it("the sign-in page is only sent to a service it checks the issuer of", async () => {
    await r.cleanup();
    r = await rig({ auth: { sendIss: true } });
    const ok = await r.begin("maria@acme.example");
    expect(ok.back.get("iss")).toBe(r.auth.url);
    expect((await r.connect.callback(ok.back)).ok).toBe(true);
    // A server that promises `iss` and does not send it is refused.
    const again = await r.begin("maria@acme.example", { org: "globex" });
    const stripped = new URLSearchParams(again.back);
    stripped.delete("iss");
    expect((await r.connect.callback(stripped)).ok).toBe(false);
  });
});

describe("tokens: fresh, single flight, saved before use", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
    await r.connectAs("maria@acme.example");
  });
  afterEach(() => r.cleanup());

  const bearer = async (id = "fakesvc") => {
    const got = await r.connect.bearer(id);
    if (!("token" in got)) throw new Error(got.problem);
    return got.token;
  };

  it("renews an expired token once and keeps the rotated refresh token", async () => {
    const before = await r.grants.get("fakesvc");
    r.skip(2 * 3600_000);
    r.auth.expireAccessTokens();
    const token = await bearer();
    expect(token).not.toBe(before?.tokens.accessToken);
    expect(r.auth.refreshCalls).toBe(1);
    // The new refresh token was saved before the new access token was handed out.
    const after = await r.grants.get("fakesvc");
    expect(after?.tokens.accessToken).toBe(token);
    expect(after?.tokens.refreshToken).not.toBe(before?.tokens.refreshToken);
    // A restarted majhi, reading only the store, renews again with the saved refresh token.
    r.skip(2 * 3600_000);
    r.auth.expireAccessTokens();
    const restarted = r.again();
    const next = await restarted.bearer("fakesvc");
    expect("token" in next && next.token !== token).toBe(true);
    expect(r.auth.refreshCalls).toBe(2);
  });

  it("five callers at once make one refresh and share the answer", async () => {
    r.skip(2 * 3600_000);
    r.auth.expireAccessTokens();
    r.auth.hold();
    const calls = Array.from({ length: 5 }, () => r.connect.bearer("fakesvc"));
    await until(() => r.auth.refreshCalls >= 1);
    r.auth.release();
    const answers = await Promise.all(calls);
    const tokens = new Set(answers.map((a) => ("token" in a ? a.token : a.problem)));
    expect(tokens.size).toBe(1);
    expect(r.auth.refreshCalls).toBe(1);
    expect((await r.grants.get("fakesvc"))?.state).toBe("connected");
  });

  it("when the service refuses the renewal the connection needs a new sign-in, with one notice", async () => {
    r.skip(2 * 3600_000);
    r.auth.expireAccessTokens();
    r.auth.failRefresh = "invalid_grant";
    const first = await r.connect.bearer("fakesvc");
    expect("problem" in first).toBe(true);
    await r.connect.bearer("fakesvc");
    await r.connect.bearer("fakesvc");
    const [status] = await r.connect.status("acme");
    expect(status?.state).toBe("needs-reconnect");
    expect(r.attention).toHaveLength(1);
    // It was one refresh: after needs-reconnect majhi stops asking the service.
    expect(r.auth.refreshCalls).toBe(1);
    // The connection stays, so Reconnect has something to renew.
    expect(r.connections.has("fakesvc")).toBe(true);
  });

  it("network loss never marks the grant revoked; the token that has not ended keeps working", async () => {
    const live = (await r.grants.get("fakesvc"))?.tokens.accessToken;
    // 58 minutes into a one hour token: due for renewal, not yet ended.
    r.skip(58 * 60_000);
    await r.auth.stop();
    expect(await bearer()).toBe(live);
    expect((await r.grants.get("fakesvc"))?.state).toBe("connected");
    // Once it has ended and the service is still away, the run gets a plain reason, not a dead token.
    r.skip(10 * 60_000);
    r.skip(60 * 60_000);
    const got = await r.connect.bearer("fakesvc");
    expect("problem" in got).toBe(true);
    expect((await r.grants.get("fakesvc"))?.state).toBe("connected");
    expect(r.attention).toEqual([]);
    // The service comes back, and after the wait majhi renews.
    await r.auth.start();
    r.skip(11 * 60_000);
    expect("token" in (await r.connect.bearer("fakesvc"))).toBe(true);
  });

  it("a token the service stopped accepting is renewed once, and then called revoked", async () => {
    r.mcp.rejectAll = true;
    const result = await r.connect.test("fakesvc");
    expect(result.ok).toBe(false);
    const [status] = await r.connect.status("acme");
    expect(status?.state).toBe("revoked");
    expect(r.attention.map((a) => a.key)).toEqual(["connect:fakesvc:revoked"]);
    // A revoked grant hands out no token.
    expect("problem" in (await r.connect.bearer("fakesvc"))).toBe(true);
  });
});

describe("accounts and access", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(() => r.cleanup());

  it("a reconnect that signs in as another account changes nothing until the owner agrees", async () => {
    await r.connectAs("maria@acme.example");
    const before = await r.grants.get("fakesvc");
    const view = await r.connectAs("bob@globex.example", { connection: "fakesvc" });
    expect(view.state).toBe("confirm-account");
    expect(view.previousAccount).toBe("maria@acme.example");
    expect(await r.grants.get("fakesvc")).toEqual(before);

    // The owner keeps the old account: the other sign-in is dropped and revoked at the service.
    const kept = await r.connect.confirmAccount(view.flow, false);
    expect(kept.state).toBe("cancelled");
    expect(await r.grants.get("fakesvc")).toEqual(before);
    expect(r.auth.revoked.length).toBeGreaterThan(0);
    const [status] = await r.connect.status("acme");
    expect(status?.account).toBe("maria@acme.example");
  });

  it("two workspaces connect the same service as different accounts and never see each other's token", async () => {
    await r.connectAs("maria@acme.example", { org: "acme" });
    const globex = await r.connectAs("bob@globex.example", { org: "globex" });
    const acmeId = [...r.connections].find(([, c]) => c.org === "acme")?.[0] ?? "";
    const globexId = globex.connection ?? "";
    expect(globexId).not.toBe(acmeId);
    const acme = await r.connect.bearer(acmeId);
    const gx = await r.connect.bearer(globexId);
    if (!("token" in acme) || !("token" in gx)) throw new Error("no token");
    expect(acme.token).not.toBe(gx.token);
    expect(r.auth.accessOf(acme.token)?.account).toBe("maria@acme.example");
    expect(r.auth.accessOf(gx.token)?.account).toBe("bob@globex.example");
    expect((await r.connect.status("acme")).map((s) => s.account)).toEqual(["maria@acme.example"]);
    expect((await r.connect.status("globex")).map((s) => s.account)).toEqual(["bob@globex.example"]);
    // Disconnecting one leaves the other.
    const out = await r.connect.disconnect(globexId, OWNER);
    expect(out.revoked).toBe(true);
    expect("token" in (await r.connect.bearer(acmeId))).toBe(true);
    expect(await r.grants.get(globexId)).toBeUndefined();
  });

  it("a connection of another workspace cannot be reconnected from this one", async () => {
    await r.connectAs("maria@acme.example", { org: "acme" });
    await expect(
      r.connect.start({ org: "globex", service: "fakesvc", access: "read", connection: "fakesvc" }, OWNER),
    ).rejects.toThrow();
  });

  it("disconnect revokes at the service, deletes the tokens and the connection", async () => {
    await r.connectAs("maria@acme.example");
    const grant = await r.grants.get("fakesvc");
    const out = await r.connect.disconnect("fakesvc", OWNER);
    expect(out).toMatchObject({ removed: "fakesvc", revoked: true });
    expect(r.auth.revoked).toEqual(
      expect.arrayContaining([grant?.tokens.refreshToken, grant?.tokens.accessToken]),
    );
    expect(await r.grants.get("fakesvc")).toBeUndefined();
    expect(r.connections.size).toBe(0);
  });
});

describe("secrets stay out of logs, views and errors", () => {
  it("never writes a token, code or state anywhere it can be read", async () => {
    const r = await rig();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const seen: string[] = [];
    const record = (value: unknown) => seen.push(typeof value === "string" ? value : JSON.stringify(value));
    try {
      const started = await r.connect.start({ org: "acme", service: "fakesvc", access: "readwrite" }, OWNER);
      // The waiting page's own address holds the state on purpose: the owner opens it.
      const state = new URL(started.url ?? "").searchParams.get("state") ?? "";
      const back = new URL(r.auth.approve(started.url ?? "", { account: "maria@acme.example" }));
      const code = back.searchParams.get("code") ?? "";
      record((await r.connect.callback(back.searchParams)).message);
      record(r.connect.flow(started.flow));
      record(await r.connect.status());
      record(started.message);
      record(await r.connect.test("fakesvc"));
      // A failed renewal, a denied page, a replay and a forged state.
      r.skip(2 * 3600_000);
      r.auth.failRefresh = "invalid_grant";
      record(await r.connect.bearer("fakesvc"));
      record((await r.connect.callback(back.searchParams)).message);
      const denied = await r.begin("maria@acme.example", { org: "globex", deny: true });
      record((await r.connect.callback(denied.back)).message);
      record({ ...r.connect.flow(denied.flow), url: undefined });
      record(r.logs.join("\n"));
      for (const spy of spies) record(spy.mock.calls.flat().map(String).join("\n"));
      record(r.attention);

      const everything = seen.join("\n");
      expect(everything.length).toBeGreaterThan(0);
      for (const secret of [...r.auth.secretsSeen(), state, code]) {
        expect(everything).not.toContain(secret);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      await r.cleanup();
    }
  });
});
