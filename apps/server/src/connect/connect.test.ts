import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandMeta, ConnectionConfig } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listTools, remoteTransport } from "../connections/mcp-client.ts";
import { generateKey, SecretStore } from "../secrets/store.ts";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
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
    options?: { org?: string; connection?: string; access?: "read" | "readwrite"; scope?: string[] },
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
    helper?: boolean;
    cimdUrl?: string;
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
  const mcp = new FakeMcpServer(
    auth,
    options.requiredScope === undefined ? {} : { requiredScope: options.requiredScope },
  );
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
      catalog: [fakeService(mcp.url)],
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

  it("connects in one pass: page, callback, account, access in words, test, status", async () => {
    const started = await r.connect.start({ org: "acme", service: "fakesvc", access: "read" }, OWNER);
    expect(started.state).toBe("waiting");
    expect(started.message).toContain("Waiting for you in the browser");
    // The helper is offline, so the page address is shown.
    expect(started.opened).toBe(false);
    const url = new URL(started.url ?? "");
    expect(url.origin).toBe(r.auth.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(r.mcp.url);
    expect(url.searchParams.get("scope")).toBe("read");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);

    const back = new URL(r.auth.approve(started.url ?? "", { account: "maria@acme.example" }));
    const result = await r.connect.callback(back.searchParams);
    expect(result.ok).toBe(true);

    const done = r.connect.flow(started.flow);
    expect(done.state).toBe("connected");
    expect(done.message).toBe("Connected as maria@acme.example.");
    expect(done.account).toBe("maria@acme.example");
    expect(done.scopes).toEqual([{ access: "read", sentence: "Read issues." }]);
    expect(done.test?.ok).toBe(true);
    expect(done.test?.tools).toEqual(["list_issues", "create_issue"]);

    expect(await r.connect.status("acme")).toEqual([
      {
        connection: "fakesvc",
        org: "acme",
        service: "fakesvc",
        serviceName: "Fake Service",
        state: "connected",
        reason: "Connected.",
        account: "maria@acme.example",
        scopes: [{ access: "read", sentence: "Read issues." }],
        missing: [],
        connectedAt: expect.any(String),
        expiresAt: expect.any(String),
        renews: true,
        revocable: true,
      },
    ]);
    // The connection is a remote MCP server whose sign-in is OAuth, with no header to paste.
    expect(r.connections.get("fakesvc")?.connection.fields).toEqual({
      transport: "remote",
      url: r.mcp.url,
      protocol: "http",
      auth: "oauth",
    });
    // The tokens are encrypted at rest.
    const token = (await r.grants.get("fakesvc"))?.tokens.accessToken ?? "";
    expect(token).toMatch(/^at-/);
    expect((await readFile(r.secrets.file)).includes(token)).toBe(false);
  });

  it("asks the host helper to open the page, and then shows no address", async () => {
    await r.cleanup();
    r = await rig({ helper: true });
    const flow = await r.connect.start({ org: "acme", service: "fakesvc", access: "read" }, OWNER);
    expect(flow.opened).toBe(true);
    expect(flow.url).toBeUndefined();
    expect(r.opened).toHaveLength(1);
  });

  it("asks for write access only when the owner chose it", async () => {
    const flow = await r.connect.start({ org: "acme", service: "fakesvc", access: "readwrite" }, OWNER);
    expect(new URL(flow.url ?? "").searchParams.get("scope")).toBe("read write");
  });

  it("denied consent saves nothing and says so", async () => {
    const { flow, back } = await r.begin("maria@acme.example", { deny: true });
    const result = await r.connect.callback(back);
    expect(result.ok).toBe(false);
    expect(r.connect.flow(flow).state).toBe("denied");
    expect(r.connect.flow(flow).message).toBe("You did not allow Fake Service. Nothing was saved.");
    expect(r.connections.size).toBe(0);
    expect(await r.grants.connections()).toEqual([]);
  });

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
    expect(replay.message).toContain("already used");
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

  it("an expired code ends with nothing saved", async () => {
    const { flow, back } = await r.begin("maria@acme.example");
    r.auth.expireCodes();
    const result = await r.connect.callback(back);
    expect(result.ok).toBe(false);
    const view = r.connect.flow(flow);
    expect(view.state).toBe("failed");
    expect(view.message).toMatch(/ no longer accepts this sign-in\. Nothing was saved\. Start again\.$/);
    expect(r.connections.size).toBe(0);
    expect(await r.grants.connections()).toEqual([]);
  });

  it("refuses an answer that names another issuer", async () => {
    const { flow, back } = await r.begin("maria@acme.example");
    const odd = new URLSearchParams(back);
    odd.set("iss", "https://evil.example");
    expect((await r.connect.callback(odd)).ok).toBe(false);
    expect(r.connect.flow(flow).message).toContain("did not come from the service majhi asked");
    expect(r.connections.size).toBe(0);
  });

  it("network loss between the page and the exchange ends cleanly", async () => {
    const { flow, back } = await r.begin("maria@acme.example");
    await r.auth.stop();
    const result = await r.connect.callback(back);
    expect(result.ok).toBe(false);
    expect(r.connect.flow(flow).state).toBe("failed");
    expect(r.connect.flow(flow).message).toContain("Nothing was saved");
    expect(r.connections.size).toBe(0);
    expect(await r.grants.connections()).toEqual([]);
    await r.auth.start();
  });

  it("cancel stops waiting and a late answer is refused", async () => {
    const { flow, back } = await r.begin("maria@acme.example");
    expect(r.connect.cancel(flow).state).toBe("cancelled");
    expect((await r.connect.callback(back)).ok).toBe(false);
    expect(r.connections.size).toBe(0);
  });

  it("a second click replaces the first attempt", async () => {
    const first = await r.begin("maria@acme.example");
    await r.begin("maria@acme.example");
    expect(r.connect.flow(first.flow).state).toBe("cancelled");
    expect((await r.connect.callback(first.back)).ok).toBe(false);
  });

  it("registers once per issuer and reuses the registration for another workspace", async () => {
    await r.connectAs("maria@acme.example", { org: "acme" });
    await r.connectAs("bob@globex.example", { org: "globex" });
    expect(r.auth.registrations).toBe(1);
    // A different issuer is a different registration.
    const other = new FakeAuthServer();
    await other.start();
    const otherMcp = new FakeMcpServer(other);
    await otherMcp.start();
    const second = new ConnectService({
      grants: r.grants,
      apps: new AppClientStore(r.secrets),
      orgName: async (org) => org,
      secretOf: async () => undefined,
      connections: {
        create: async () => undefined,
        remove: async () => undefined,
        find: async () => undefined,
      },
      connectionIds: async () => [],
      orgExists: async () => true,
      redirect: REDIRECT,
      openUrl: async () => false,
      helperConnected: () => false,
      changed: () => undefined,
      listTools: async () => [],
      catalog: [fakeService(otherMcp.url)],
    });
    await second.start({ org: "acme", service: "fakesvc", access: "read" }, OWNER);
    expect(other.registrations).toBe(1);
    expect(r.auth.registrations).toBe(1);
    await other.stop();
    await otherMcp.stop();
  });

  it("a server that offers no registration gets a plain answer and saves nothing", async () => {
    await r.cleanup();
    r = await rig({ auth: { dcr: false } });
    await expect(r.connect.start({ org: "acme", service: "fakesvc", access: "read" }, OWNER)).rejects.toThrow(
      "does not let majhi register itself",
    );
    expect(r.connections.size).toBe(0);
  });

  it("uses the client metadata document when one is configured and the server takes it", async () => {
    await r.cleanup();
    const cimd = "https://majhi.example/oauth/client.json";
    r = await rig({ auth: { cimd: true }, cimdUrl: cimd });
    const flow = await r.connect.start({ org: "acme", service: "fakesvc", access: "read" }, OWNER);
    expect(new URL(flow.url ?? "").searchParams.get("client_id")).toBe(cimd);
    expect(r.auth.registrations).toBe(0);
    const back = new URL(r.auth.approve(flow.url ?? "", { account: "maria@acme.example" }));
    expect((await r.connect.callback(back.searchParams)).ok).toBe(true);
  });

  it("uses dynamic registration when no metadata document is configured, even if the server takes one", async () => {
    await r.cleanup();
    r = await rig({ auth: { cimd: true } });
    await r.connect.start({ org: "acme", service: "fakesvc", access: "read" }, OWNER);
    expect(r.auth.registrations).toBe(1);
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

  it("hands out the token as it is while it has time", async () => {
    const first = (await r.grants.get("fakesvc"))?.tokens.accessToken;
    expect(await bearer()).toBe(first);
    expect(r.auth.refreshCalls).toBe(0);
  });

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
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    expect(first).toEqual({ problem: "Fake Service no longer accepts majhi's sign-in. Reconnect it." });
    await r.connect.bearer("fakesvc");
    await r.connect.bearer("fakesvc");
    const [status] = await r.connect.status("acme");
    expect(status?.state).toBe("needs-reconnect");
    expect(status?.reason).toBe("Fake Service no longer accepts majhi's sign-in. Reconnect it.");
    expect(r.attention.map((a) => a.title)).toEqual(["Fake Service needs you to sign in again"]);
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
    expect(got).toEqual({
      problem: "The service is unreachable, so its token could not be renewed. majhi tries again soon.",
    });
    expect((await r.grants.get("fakesvc"))?.state).toBe("connected");
    expect(r.attention).toEqual([]);
    // The service comes back, and after the wait majhi renews.
    await r.auth.start();
    r.skip(11 * 60_000);
    expect("token" in (await r.connect.bearer("fakesvc"))).toBe(true);
  });

  it("a server error on renewal is not a refusal", async () => {
    r.skip(2 * 3600_000);
    r.auth.failRefresh = "server_error";
    expect(Object.hasOwn(await r.connect.bearer("fakesvc"), "problem")).toBe(true);
    expect((await r.grants.get("fakesvc"))?.state).toBe("connected");
    expect(r.attention).toEqual([]);
  });

  it("the background pass renews tokens that end soon and restarts the sessions that hold them", async () => {
    r.skip(55 * 60_000);
    await r.connect.sweep();
    expect(r.auth.refreshCalls).toBe(1);
    expect(r.remounted).toEqual(["fakesvc"]);
    await r.connect.sweep();
    expect(r.auth.refreshCalls).toBe(1);
  });

  it("a token the service stopped accepting is renewed once, and then called revoked", async () => {
    r.mcp.rejectAll = true;
    const result = await r.connect.test("fakesvc");
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("Fake Service no longer accepts majhi. The access was revoked. Reconnect it.");
    const [status] = await r.connect.status("acme");
    expect(status?.state).toBe("revoked");
    expect(r.attention.map((a) => a.key)).toEqual(["connect:fakesvc:revoked"]);
    // A revoked grant hands out no token.
    expect("problem" in (await r.connect.bearer("fakesvc"))).toBe(true);
  });

  it("when the access token was cut short but the grant is good, the test renews and passes", async () => {
    r.auth.expireAccessTokens();
    const result = await r.connect.test("fakesvc");
    expect(result.ok).toBe(true);
    expect(r.auth.refreshCalls).toBe(1);
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
    expect(view.message).toBe(
      "This signed in as bob@globex.example, but Fake Service here is maria@acme.example. Nothing changed.",
    );
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

  it("the owner can replace the account, and the old account loses its access", async () => {
    await r.connectAs("maria@acme.example");
    const old = (await r.grants.get("fakesvc"))?.tokens;
    const view = await r.connectAs("bob@globex.example", { connection: "fakesvc" });
    const replaced = await r.connect.confirmAccount(view.flow, true);
    expect(replaced.state).toBe("connected");
    const [status] = await r.connect.status("acme");
    expect(status?.account).toBe("bob@globex.example");
    expect(r.auth.accessOf(old?.accessToken ?? "")).toBeUndefined();
    expect(r.auth.revoked).toContain(old?.refreshToken);
  });

  it("the same account signing in again is a plain reconnect", async () => {
    await r.connectAs("maria@acme.example");
    const view = await r.connectAs("maria@acme.example", { connection: "fakesvc" });
    expect(view.state).toBe("connected");
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

  it("one connection per service in a workspace; asking again points to Reconnect", async () => {
    await r.connectAs("maria@acme.example");
    await expect(r.connect.start({ org: "acme", service: "fakesvc", access: "read" }, OWNER)).rejects.toThrow(
      "already connected in acme as fakesvc. Use Reconnect there.",
    );
  });

  it("a connection of another workspace cannot be reconnected from this one", async () => {
    await r.connectAs("maria@acme.example", { org: "acme" });
    await expect(
      r.connect.start({ org: "globex", service: "fakesvc", access: "read", connection: "fakesvc" }, OWNER),
    ).rejects.toThrow("not a connected service of globex");
  });

  it("granular consent: less access than asked for is named, and Reconnect asks for it again", async () => {
    r.auth.maxScope = ["read"];
    const view = await r.connectAs("maria@acme.example", { access: "readwrite" });
    expect(view.state).toBe("connected");
    const [status] = await r.connect.status("acme");
    expect(status?.state).toBe("insufficient-scope");
    expect(status?.missing).toEqual(["write"]);
    expect(status?.reason).toBe(
      "Fake Service gave less access than asked for: write is missing. Reconnect and allow it.",
    );
    // The token still works for what was granted.
    expect("token" in (await r.connect.bearer("fakesvc"))).toBe(true);
    // The owner allows it the second time.
    r.auth.maxScope = undefined;
    await r.connectAs("maria@acme.example", { connection: "fakesvc", access: "readwrite" });
    const [after] = await r.connect.status("acme");
    expect(after?.state).toBe("connected");
    expect(after?.missing).toEqual([]);
    expect(after?.scopes).toEqual([{ access: "write", sentence: "Create and change issues." }]);
  });

  it("a 403 insufficient_scope from the server asks for more access, with the union of scopes", async () => {
    await r.cleanup();
    r = await rig({ requiredScope: "write" });
    await r.connectAs("maria@acme.example");
    // The server wants `write`, which the owner did not give.
    const result = await r.connect.test("fakesvc");
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("Fake Service needs more access (write). Reconnect and allow it.");
    const [status] = await r.connect.status("acme");
    expect(status?.state).toBe("insufficient-scope");
    expect(status?.missing).toEqual(["write"]);
    expect(r.attention.map((a) => a.title)).toEqual(["Fake Service asks for more access"]);
    // Testing again does not file a second notice.
    await r.connect.test("fakesvc");
    expect(r.attention).toHaveLength(1);
    // Allow more access: the next page asks for what it had and what it lacked.
    const flow = await r.connect.start(
      { org: "acme", service: "fakesvc", access: "read", connection: "fakesvc" },
      OWNER,
    );
    expect(new URL(flow.url ?? "").searchParams.get("scope")).toBe("read write");
    const back = new URL(r.auth.approve(flow.url ?? "", { account: "maria@acme.example" }));
    await r.connect.callback(back.searchParams);
    expect((await r.connect.status("acme"))[0]?.state).toBe("connected");
    expect((await r.connect.test("fakesvc")).ok).toBe(true);
  });

  it("an agent can report a 403, which only asks the owner and never cuts the token", async () => {
    await r.connectAs("maria@acme.example");
    const status = await r.connect.needScope("fakesvc", "write");
    expect(status.state).toBe("insufficient-scope");
    expect(status.missing).toEqual(["write"]);
    expect("token" in (await r.connect.bearer("fakesvc"))).toBe(true);
    await expect(r.connect.needScope("nope", undefined)).rejects.toThrow("not a connected service");
  });

  it("disconnect revokes at the service, deletes the tokens and the connection", async () => {
    await r.connectAs("maria@acme.example");
    const grant = await r.grants.get("fakesvc");
    const out = await r.connect.disconnect("fakesvc", OWNER);
    expect(out).toEqual({
      removed: "fakesvc",
      revoked: true,
      note: "Fake Service is disconnected and its access was revoked.",
    });
    expect(r.auth.revoked).toEqual(
      expect.arrayContaining([grant?.tokens.refreshToken, grant?.tokens.accessToken]),
    );
    expect(await r.grants.get("fakesvc")).toBeUndefined();
    expect(r.connections.size).toBe(0);
  });

  it("when the service cannot revoke, disconnect says what stays and where to remove it", async () => {
    await r.cleanup();
    r = await rig({ auth: { noRevoke: true } });
    await r.connectAs("maria@acme.example");
    const out = await r.connect.disconnect("fakesvc", OWNER);
    expect(out.revoked).toBe(false);
    expect(out.note).toContain("remove majhi from the authorized apps in your Fake Service account settings");
    expect(await r.grants.get("fakesvc")).toBeUndefined();
  });

  it("removing the connection by any other route also deletes and revokes its tokens", async () => {
    await r.connectAs("maria@acme.example");
    const refresh = (await r.grants.get("fakesvc"))?.tokens.refreshToken;
    await r.connect.removed("fakesvc");
    expect(await r.grants.get("fakesvc")).toBeUndefined();
    expect(r.auth.revoked).toContain(refresh);
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
      // The log says what happened, in words.
      expect(r.logs).toContain("connect: fakesvc connected in acme");
    } finally {
      for (const spy of spies) spy.mockRestore();
      await r.cleanup();
    }
  });
});
