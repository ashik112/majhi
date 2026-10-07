import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandMeta,
  type ConnectionConfig,
  type ConnectionHealth,
  type ConnectionTestResult,
  SERVICE_CATALOG,
  type TokenMethod,
} from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionHealthService } from "../connections/health.ts";
import { generateKey, SecretStore } from "../secrets/store.ts";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { AppClientStore } from "./app-client.ts";
import { GrantStore } from "./grant.ts";
import { ConnectService } from "./service.ts";
import { checkToken } from "./token-check.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };
const TOKEN = "lin_api_acmeSecretValue0123456789";

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

interface Seen {
  url: string;
  authorization: string | undefined;
  method: string;
  redirect: string | undefined;
}

/** Linear's API as the service answers it: a viewer for the right key, 400 AUTHENTICATION_ERROR for a wrong one. */
function linear(seen: Seen[], state: { status?: number; body?: unknown } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    seen.push({
      url,
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      method: init?.method ?? "GET",
      redirect: init?.redirect,
    });
    if (state.status !== undefined) return Response.json(state.body ?? {}, { status: state.status });
    const key = new Headers(init?.headers).get("authorization");
    if (key !== TOKEN) {
      return Response.json(
        { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] },
        { status: 400 },
      );
    }
    return Response.json({ data: { viewer: { id: "u1", name: "Maria", email: "maria@acme.example" } } });
  }) as typeof fetch;
}

interface Rig {
  connect: ConnectService;
  health: ConnectionHealthService;
  connections: Map<string, { org: string; connection: ConnectionConfig }>;
  stored: Map<string, string>;
  logs: string[];
  seen: Seen[];
  state: { status?: number; body?: unknown };
  cleanup(): Promise<void>;
}

async function rig(): Promise<Rig> {
  const { dir, cleanup } = await tempDir();
  const keyFile = join(dir, "secrets.key");
  await writeKeyFile(keyFile, await generateKey());
  await mkdir(join(dir, "home"));
  const secrets = new SecretStore(join(dir, "home"), keyFile);
  const connections = new Map<string, { org: string; connection: ConnectionConfig }>();
  const stored = new Map<string, string>();
  const logs: string[] = [];
  const seen: Seen[] = [];
  const state: Rig["state"] = {};
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
    grants: new GrantStore(secrets),
    apps: new AppClientStore(secrets),
    orgName: async (org) => org,
    secretOf: async (id, name) => stored.get(`${id}/${name}`),
    connections: {
      async create(input) {
        connections.set(input.id ?? input.name, {
          org: input.org,
          connection: {
            type: input.type,
            name: input.name,
            description: input.description,
            fields: input.fields,
            vars: input.vars,
          } as ConnectionConfig,
        });
      },
      async remove(id) {
        connections.delete(id);
      },
      async find(id) {
        return connections.get(id);
      },
      async setSecret(input) {
        if (input.value !== undefined) stored.set(`${input.id}/${input.field}`, input.value);
      },
    },
    connectionIds: async () => [...connections].map(([id, c]) => ({ id, ...c })),
    orgExists: async (org) => org === "acme",
    redirect: "http://127.0.0.1:7070/oauth/callback",
    openUrl: async () => false,
    helperConnected: () => false,
    changed: () => undefined,
    listTools: async () => [],
    catalog: SERVICE_CATALOG,
    fetch: linear(seen, state),
    health,
    log: (line) => logs.push(line),
  });
  return {
    connect,
    health,
    connections,
    stored,
    logs,
    seen,
    state,
    cleanup: async () => {
      connect.stop();
      await cleanup();
    },
  };
}

let r: Rig;
afterEach(async () => {
  await r?.cleanup();
});

describe("a pasted token connects only when a real call with it passes", () => {
  it("a wrong token saves nothing and is a typed rejection with the page to make a new one", async () => {
    r = await rig();
    const out = await r.connect.connectToken(
      { org: "acme", service: "linear-key", token: "lin_api_wrong0123456789" },
      OWNER,
    );
    expect(out).toMatchObject({
      ok: false,
      failure: { reason: "rejected", status: 400 },
    });
    expect(r.connections.size).toBe(0);
    expect(r.stored.size).toBe(0);
  });

  it("the token goes only in an Authorization header, to Linear's host, with no redirect followed, and never into a URL, a log or a state", async () => {
    r = await rig();
    const out = await r.connect.connectToken({ org: "acme", service: "linear-key", token: TOKEN }, OWNER);
    for (const call of r.seen) {
      expect(new URL(call.url).host).toBe("api.linear.app");
      expect(call.url).not.toContain(TOKEN);
      expect(call.authorization).toBe(TOKEN);
      expect(call.redirect).toBe("manual");
    }
    const id = out.ok ? out.connection : "";
    const everything =
      JSON.stringify(r.health.get(id)) +
      JSON.stringify([...r.connections]) +
      r.logs.join("\n") +
      JSON.stringify(await r.connect.status());
    expect(everything).not.toContain(TOKEN);
    // It is stored once, as a secret value of the connection, and nowhere in its config.
    expect([...r.stored.values()]).toEqual([TOKEN]);
  });

  it("a token that later stops working needs attention, and a re-check that passes heals it", async () => {
    r = await rig();
    const out = await r.connect.connectToken({ org: "acme", service: "linear-key", token: TOKEN }, OWNER);
    const id = out.ok ? out.connection : "";
    r.state.status = 401;
    await r.health.check(id);
    expect(r.health.get(id)).toMatchObject({ state: "needs-attention", reason: "rejected" });
    delete r.state.status;
    await r.health.check(id);
    expect(r.health.get(id)?.state).toBe("connected");
  });
});

describe("checkToken", () => {
  const method = (hosts: string[], url = "https://api.acme.test/me"): TokenMethod => ({
    variable: "ACME_TOKEN",
    page: { label: "Open", url: "https://acme.test/tokens" },
    steps: ["Make one"],
    scopes: [],
    auth: "bearer",
    check: { url, method: "GET", labelPaths: [["user", "name"]], did: "Asked Acme who it is" },
    hosts,
  });
  const answer = (status: number, body: unknown) =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch;

  it("never sends a token to a host the service entry does not name", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    expect(await checkToken(fetchFn, method(["api.other.test"]), TOKEN)).toMatchObject({
      ok: false,
      failure: { reason: "blocked-host" },
    });
    expect(called).toBe(false);
  });

  it("a 200 that does not name an account is not a pass (a login page, a proxy)", async () => {
    expect(
      await checkToken(answer(200, { html: "<form>log in</form>" }), method(["api.acme.test"]), TOKEN),
    ).toMatchObject({
      ok: false,
      failure: { reason: "unexpected", status: 200 },
    });
  });

  it("a redirect is never followed: it is an unexpected answer", async () => {
    const fetchFn = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test" },
      })) as unknown as typeof fetch;
    expect(await checkToken(fetchFn, method(["api.acme.test"]), TOKEN)).toMatchObject({
      ok: false,
      failure: { reason: "unexpected", status: 302 },
    });
  });
});
