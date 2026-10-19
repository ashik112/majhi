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

  it.each<[string, () => Promise<void>]>([
    [
      "a replayed answer: the state works once",
      async () => {
        const { back } = await r.begin("maria@acme.example");
        expect((await r.connect.callback(back)).ok).toBe(true);
        const first = (await r.grants.get("fakesvc"))?.tokens.accessToken;
        const replay = await r.connect.callback(back);
        expect(replay.ok).toBe(false);
        expect((await r.grants.get("fakesvc"))?.tokens.accessToken).toBe(first);
      },
    ],
    [
      "an answer for another workspace's attempt",
      async () => {
        const a = await r.begin("maria@acme.example", { org: "acme" });
        const b = await r.begin("bob@globex.example", { org: "globex" });
        // Acme's code under Globex's state: the code was made for Acme's PKCE challenge.
        const mixed = new URLSearchParams(a.back);
        mixed.set("state", b.back.get("state") ?? "");
        expect((await r.connect.callback(mixed)).ok).toBe(false);
        expect(r.connect.flow(b.flow).state).toBe("failed");
        expect(r.connections.has("fakesvc-2")).toBe(false);
        // The service burned the code when it saw it presented with the wrong verifier.
        expect((await r.connect.callback(a.back)).ok).toBe(false);
        expect(r.connections.size).toBe(0);
        expect(await r.grants.connections()).toEqual([]);
      },
    ],
    [
      "an answer that names another issuer",
      async () => {
        const { back } = await r.begin("maria@acme.example");
        const odd = new URLSearchParams(back);
        odd.set("iss", "https://evil.example");
        expect((await r.connect.callback(odd)).ok).toBe(false);
        expect(r.connections.size).toBe(0);
      },
    ],
    [
      "an answer after the page timed out",
      async () => {
        const { flow, back } = await r.begin("maria@acme.example");
        r.skip(FLOW_TTL_MS + 1000);
        expect((await r.connect.callback(back)).ok).toBe(false);
        expect(r.connect.flow(flow).state).toBe("expired");
        expect(r.connections.size).toBe(0);
      },
    ],
  ])(
    "accepts a sign-in answer once and only for the workspace and issuer that began it: refuses %s",
    async (_name, run) => {
      await run();
    },
  );
});
