import { describe, expect, it } from "vitest";
import { McpUrlService } from "./mcp-url.ts";

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function service(
  routes: Record<string, Route>,
  lookup: (n: string) => Promise<string[]> = async () => ["203.0.114.7"],
) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    const route = routes[`${init?.method ?? "GET"} ${url.host}${url.pathname}`];
    return route === undefined ? new Response("{}", { status: 404 }) : route(url, init);
  }) as typeof fetch;
  const created: unknown[] = [];
  const removed: string[] = [];
  const secrets: { id: string; field: string; value: string }[] = [];
  const checks: string[] = [];
  const svc = new McpUrlService({
    fetch: fetchFn,
    lookup,
    clientMetadataUrl: undefined,
    connections: {
      create: async (input) => void created.push(input),
      setSecret: async (input) => void secrets.push({ id: input.id, field: input.field, value: input.value }),
      remove: async (id) => void removed.push(id),
    },
    connectionIds: async () => [],
    orgExists: async (org) => org === "acme",
    check: async (id) => {
      checks.push(id);
      return { ok: true };
    },
    health: { start: () => undefined, remove: () => undefined },
    changed: () => undefined,
  });
  return { svc, calls, created, removed, secrets, checks };
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "www-authenticate":
        'Bearer resource_metadata="https://mcp.acme.test/.well-known/oauth-protected-resource"',
    },
  });

const metadata = (registration: boolean): Record<string, Route> => ({
  "POST mcp.acme.test/mcp": unauthorized,
  "GET mcp.acme.test/.well-known/oauth-protected-resource": () =>
    Response.json({
      resource: "https://mcp.acme.test/mcp",
      authorization_servers: ["https://auth.acme.test"],
    }),
  "GET auth.acme.test/.well-known/oauth-authorization-server": () =>
    Response.json({
      issuer: "https://auth.acme.test",
      authorization_endpoint: "https://auth.acme.test/authorize",
      token_endpoint: "https://auth.acme.test/token",
      ...(registration ? { registration_endpoint: "https://auth.acme.test/register" } : {}),
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    }),
});

describe("probing an MCP server by address", () => {
  it("answers private, loopback and metadata addresses with a blocked-host reason before any request, unless the owner confirms a private one", async () => {
    const t = service({}, async () => ["10.0.0.9"]);
    for (const url of ["https://localhost/mcp", "https://192.168.1.5/mcp", "https://mcp.acme.test/mcp"]) {
      expect(await t.svc.probe({ url })).toMatchObject({
        method: "unreachable",
        failure: { reason: "blocked-host" },
      });
    }
    expect(await t.svc.probe({ url: "https://169.254.169.254/mcp", allowPrivate: true })).toMatchObject({
      method: "unreachable",
      failure: { reason: "blocked-host" },
    });
    expect(t.calls).toEqual([]);
  });

  it("refuses http for a public server and a sign-in written into the address, with the reason", async () => {
    const t = service({});
    expect(await t.svc.probe({ url: "http://mcp.acme.test/mcp" })).toMatchObject({
      method: "unreachable",
      failure: { reason: "blocked-host" },
    });
    expect(await t.svc.probe({ url: "https://user:pass@mcp.acme.test/mcp" })).toMatchObject({
      method: "unreachable",
    });
  });

  it("does not send the owner's address anywhere but the address, and no credential on the first look", async () => {
    const t = service(metadata(true));
    await t.svc.probe({ url: "https://mcp.acme.test/mcp" });
    expect(new Set(t.calls.map((c) => c.split(" ")[1]?.split("/")[0]))).toEqual(
      new Set(["mcp.acme.test", "auth.acme.test"]),
    );
  });
});
