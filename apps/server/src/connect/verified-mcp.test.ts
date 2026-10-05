import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommandMeta, ConnectionConfig, ConnectionHealth, ConnectionTestResult } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionHealthService } from "../connections/health.ts";
import { listTools, remoteTransport } from "../connections/mcp-client.ts";
import { UserError } from "../errors.ts";
import { generateKey, SecretStore } from "../secrets/store.ts";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { AppClientStore } from "./app-client.ts";
import { GrantStore } from "./grant.ts";
import { ConnectService } from "./service.ts";
import { FakeAuthServer, FakeMcpServer, fakeService } from "./testing/fakes.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };
const REDIRECT = "http://127.0.0.1:7070/oauth/callback";

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
  auth: FakeAuthServer;
  mcp: FakeMcpServer;
  connections: Map<string, { org: string; connection: ConnectionConfig }>;
  logs: string[];
  opened: string[];
  cleanup(): Promise<void>;
}

async function rig(
  options: {
    listTools?: (url: string, token: string) => Promise<string[]>;
    lookup?: (name: string) => Promise<string[]>;
    fetch?: typeof fetch;
    catalog?: boolean;
  } = {},
): Promise<Rig> {
  const { dir, cleanup } = await tempDir();
  const keyFile = join(dir, "secrets.key");
  await writeKeyFile(keyFile, await generateKey());
  await mkdir(join(dir, "home"));
  const secrets = new SecretStore(join(dir, "home"), keyFile);
  const grants = new GrantStore(secrets);
  const auth = new FakeAuthServer();
  await auth.start();
  const mcp = new FakeMcpServer(auth, {});
  await mcp.start();
  const connections = new Map<string, { org: string; connection: ConnectionConfig }>();
  const logs: string[] = [];
  const opened: string[] = [];
  let connect: ConnectService;
  const health = new ConnectionHealthService({
    repo: new MemoryRepo(),
    list: async () => [...connections].map(([id, c]) => ({ id, org: c.org, name: c.connection.name })),
    check: async (id): Promise<ConnectionTestResult> => {
      const result = await connect.test(id);
      health.observe(id, result);
      return result;
    },
    changed: () => undefined,
    gap: async () => undefined,
  });
  connect = new ConnectService({
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
    orgExists: async (org) => org === "acme",
    redirect: REDIRECT,
    openUrl: async (url) => {
      opened.push(url);
      return true;
    },
    helperConnected: () => true,
    changed: () => undefined,
    listTools:
      options.listTools ??
      ((url, token) => listTools(remoteTransport(url, { Authorization: `Bearer ${token}` }), 10_000)),
    catalog: options.catalog === false ? [] : [fakeService(mcp.url)],
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
    health,
    log: (line) => logs.push(line),
  });
  return {
    connect,
    health,
    auth,
    mcp,
    connections,
    logs,
    opened,
    async cleanup() {
      connect.stop();
      await auth.stop();
      await mcp.stop();
      await cleanup();
    },
  };
}

async function connectAs(r: Rig, input: Parameters<ConnectService["start"]>[0]) {
  const flow = await r.connect.start(input, OWNER);
  const url = flow.url ?? r.opened.at(-1) ?? "";
  await r.connect.callback(new URL(r.auth.approve(url, { account: "maria@acme.example" })).searchParams);
  return r.connect.flow(flow.flow);
}

let r: Rig;
afterEach(async () => {
  await r?.cleanup();
});

describe("a remote MCP server: connected only when initialize and tools/list passed", () => {
  it("a pass is connected, with the two calls it made and who signed in", async () => {
    r = await rig();
    const flow = await connectAs(r, { org: "acme", service: "fakesvc", access: "read" });
    expect(flow.state).toBe("connected");
    const state = r.health.get(flow.connection ?? "");
    expect(state?.state).toBe("connected");
    expect(state?.state === "connected" && state.checked).toEqual([
      expect.stringContaining("initialize"),
      expect.stringContaining("tools/list"),
    ]);
    expect(state?.state === "connected" && state.account).toBe("maria@acme.example");
  });

  it("a server that signs in and then answers 403 to tools/list is failed with forbidden, and the flow does not say connected", async () => {
    r = await rig({
      listTools: async () => {
        // What the MCP SDK throws for an HTTP 403: the status is the error's code.
        throw Object.assign(new Error("Streamable HTTP error: whatever words it likes"), { code: 403 });
      },
    });
    const flow = await connectAs(r, { org: "acme", service: "fakesvc", access: "read" });
    expect(flow.state).toBe("failed");
    expect(flow.connection).toBeDefined();
    expect(r.health.get(flow.connection ?? "")).toMatchObject({ state: "failed", reason: "forbidden" });
  });

  it("an MCP protocol error and a timeout are told apart by their codes", async () => {
    const answers = [
      Object.assign(new Error("x"), { code: -32601 }),
      Object.assign(new Error("x"), { code: -32001 }),
    ];
    let call = 0;
    r = await rig({
      listTools: async () => {
        const next = answers[call++];
        if (next === undefined) return ["a_tool"];
        throw next;
      },
    });
    const flow = await connectAs(r, { org: "acme", service: "fakesvc", access: "read" });
    const id = flow.connection ?? "";
    expect(r.health.get(id)).toMatchObject({ state: "failed", reason: "mcp-error" });
    await r.health.check(id);
    expect(r.health.get(id)).toMatchObject({ state: "failed", reason: "timeout" });
    await r.health.check(id);
    expect(r.health.get(id)?.state).toBe("connected");
  });

  it("a server that stops accepting majhi's token needs attention, with rejected", async () => {
    r = await rig();
    const flow = await connectAs(r, { org: "acme", service: "fakesvc", access: "read" });
    const id = flow.connection ?? "";
    r.mcp.rejectAll = true;
    await r.health.check(id);
    expect(r.health.get(id)).toMatchObject({ state: "needs-attention", reason: "rejected" });
  });
});

describe("an MCP server added by address", () => {
  it("needs https, unless the owner says the server is on their own network", async () => {
    r = await rig({ catalog: false });
    await expect(r.connect.start({ org: "acme", url: r.mcp.url, access: "read" }, OWNER)).rejects.toThrow(
      /https/,
    );
  });

  it("connects a server on the owner's own network when the owner confirmed it, and the grant has no catalog service", async () => {
    r = await rig({ catalog: false });
    const flow = await connectAs(r, {
      org: "acme",
      url: r.mcp.url,
      allowPrivate: true,
      name: "Local MCP",
      access: "read",
    });
    expect(flow.state).toBe("connected");
    expect(r.health.get(flow.connection ?? "")?.state).toBe("connected");
    const made = r.connections.get(flow.connection ?? "");
    expect(made?.connection.fields).toMatchObject({ url: r.mcp.url, auth: "oauth" });
  });

  it("refuses sign-in metadata that points a public server at a private address, and never calls it", async () => {
    const calls: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      calls.push(url.host);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: "https://mcp.acme.test/mcp",
          authorization_servers: ["https://auth.acme.test"],
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    r = await rig({
      catalog: false,
      fetch: fake,
      lookup: async (name) => (name === "auth.acme.test" ? ["10.0.0.5"] : ["203.0.114.7"]),
    });
    await expect(
      r.connect.start({ org: "acme", url: "https://mcp.acme.test/mcp", access: "read" }, OWNER),
    ).rejects.toBeInstanceOf(UserError);
    expect(calls).not.toContain("auth.acme.test");
  });

  it("refuses a server that names a metadata address, even when the owner confirmed the server itself", async () => {
    const calls: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      calls.push(url.hostname);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: "https://10.1.1.1/mcp",
          authorization_servers: ["https://169.254.169.254"],
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    r = await rig({ catalog: false, fetch: fake });
    await expect(
      r.connect.start(
        { org: "acme", url: "https://10.1.1.1/mcp", allowPrivate: true, access: "read" },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(UserError);
    expect(calls).not.toContain("169.254.169.254");
  });
});
