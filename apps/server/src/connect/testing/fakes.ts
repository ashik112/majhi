import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServiceEntry } from "@majhi/shared";

/**
 * A fake OAuth 2.1 authorization server and a fake MCP server, both real HTTP servers on loopback
 * ports in this process, so Connect's tests drive the real SDK calls and never touch a provider.
 * Tokens here are made-up strings; `secretsSeen()` lists every one, for the tests that assert none
 * of them is ever logged.
 */

interface Code {
  client: string;
  challenge: string;
  redirect: string;
  resource: string;
  account: string;
  scope: string[];
  expires: number;
  used: boolean;
}

interface Access {
  account: string;
  scope: string[];
  valid: boolean;
}

export interface FakeAuthOptions {
  /** Seconds an access token lives (as `expires_in`). Default 3600. */
  accessTtl?: number;
  /** Rotate the refresh token on every refresh. Default true. */
  rotate?: boolean;
  /** Offer dynamic client registration. Default true. */
  dcr?: boolean;
  /** Send `iss` on the redirect (RFC 9207). Default false. */
  sendIss?: boolean;
  /** Give no revocation endpoint. */
  noRevoke?: boolean;
  /** Tell who signed in through the userinfo endpoint. Default true. */
  userinfo?: boolean;
  /** Take a client metadata document (an https client ID) instead of registration. */
  cimd?: boolean;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** The authorization server. */
export class FakeAuthServer {
  private server: Server | undefined;
  port = 0;
  private readonly clients = new Map<string, { redirects: string[] }>();
  private readonly codes = new Map<string, Code>();
  private readonly access = new Map<string, Access>();
  private readonly refresh = new Map<
    string,
    { account: string; scope: string[]; client: string; valid: boolean }
  >();
  private readonly issued: string[] = [];
  registrations = 0;
  refreshCalls = 0;
  revoked: string[] = [];
  /** Answer refresh with this instead of success. */
  failRefresh: "invalid_grant" | "server_error" | undefined;
  /** Hold every refresh answer until `release()` is called, to line up concurrent callers. */
  private gate: Promise<void> | undefined;
  private open: (() => void) | undefined;
  /** Scopes the consent screen will grant at most (granular consent). */
  maxScope: string[] | undefined;
  readonly options: Required<FakeAuthOptions>;

  constructor(options: FakeAuthOptions = {}) {
    this.options = {
      accessTtl: options.accessTtl ?? 3600,
      rotate: options.rotate ?? true,
      dcr: options.dcr ?? true,
      sendIss: options.sendIss ?? false,
      noRevoke: options.noRevoke ?? false,
      userinfo: options.userinfo ?? true,
      cimd: options.cimd ?? false,
    };
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Listens on a free port, or on the port it had, to come back after a network loss. */
  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    this.port = await new Promise<number>((resolve) => {
      server.listen(this.port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
  }

  async stop(): Promise<void> {
    if (this.server !== undefined) await close(this.server);
    this.server = undefined;
  }

  /** Every token, code and secret this server made, to assert none reaches a log. */
  secretsSeen(): string[] {
    return [...this.issued];
  }

  /** Makes the next refresh answers wait. */
  hold(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.gate = undefined;
  }

  /** The owner's consent: returns where the browser would be sent back to. */
  approve(
    authorizeUrl: string,
    who: { account: string; deny?: boolean; scope?: string[]; state?: string; iss?: string },
  ): string {
    const url = new URL(authorizeUrl);
    const q = url.searchParams;
    const redirect = q.get("redirect_uri") ?? "";
    const client = q.get("client_id") ?? "";
    const back = new URL(redirect);
    const state = who.state ?? q.get("state") ?? "";
    const known = this.clients.get(client)?.redirects.includes(redirect) === true;
    if (!known && !(this.options.cimd && client.startsWith("http"))) {
      throw new Error("fake auth: unknown client or redirect");
    }
    if (q.get("code_challenge_method") !== "S256" || q.get("response_type") !== "code") {
      throw new Error("fake auth: PKCE S256 and response_type=code are required");
    }
    if (who.deny === true) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("state", state);
      return back.href;
    }
    const asked = (q.get("scope") ?? "").split(/\s+/).filter((s) => s !== "");
    let granted = who.scope ?? asked;
    if (this.maxScope !== undefined) granted = granted.filter((s) => this.maxScope?.includes(s));
    const code = `code-${randomBytes(12).toString("hex")}`;
    this.issued.push(code);
    this.codes.set(code, {
      client,
      challenge: q.get("code_challenge") ?? "",
      redirect,
      resource: q.get("resource") ?? "",
      account: who.account,
      scope: granted,
      expires: Date.now() + 60_000,
      used: false,
    });
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    if (this.options.sendIss || who.iss !== undefined) back.searchParams.set("iss", who.iss ?? this.url);
    return back.href;
  }

  expireCodes(): void {
    for (const c of this.codes.values()) c.expires = 0;
  }

  /** The service ends every access and refresh token of an account (the owner revoked majhi there). */
  revokeAccount(account: string): void {
    for (const a of this.access.values()) if (a.account === account) a.valid = false;
    for (const r of this.refresh.values()) if (r.account === account) r.valid = false;
  }

  /** Access tokens stop working but refresh tokens stay good. */
  expireAccessTokens(): void {
    for (const a of this.access.values()) a.valid = false;
  }

  accessOf(token: string): Access | undefined {
    const a = this.access.get(token);
    return a?.valid === true ? a : undefined;
  }

  private mint(account: string, scope: string[], client: string, ttl: number, refreshOld?: string) {
    const accessToken = `at-${randomBytes(12).toString("hex")}`;
    const refreshToken =
      refreshOld !== undefined && !this.options.rotate ? refreshOld : `rt-${randomBytes(12).toString("hex")}`;
    this.issued.push(accessToken, refreshToken);
    this.access.set(accessToken, { account, scope, valid: true });
    this.refresh.set(refreshToken, { account, scope, client, valid: true });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ttl,
      refresh_token: refreshToken,
      scope: scope.join(" "),
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;
    if (path === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: this.url,
        authorization_endpoint: `${this.url}/authorize`,
        token_endpoint: `${this.url}/token`,
        ...(this.options.dcr ? { registration_endpoint: `${this.url}/register` } : {}),
        ...(this.options.noRevoke ? {} : { revocation_endpoint: `${this.url}/revoke` }),
        ...(this.options.userinfo ? { userinfo_endpoint: `${this.url}/userinfo` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        ...(this.options.cimd ? { client_id_metadata_document_supported: true } : {}),
        ...(this.options.sendIss ? { authorization_response_iss_parameter_supported: true } : {}),
      });
    }
    if (path === "/register" && req.method === "POST") {
      const meta = JSON.parse(await body(req)) as { redirect_uris: string[] };
      this.registrations++;
      const clientId = `client-${randomBytes(6).toString("hex")}`;
      this.clients.set(clientId, { redirects: meta.redirect_uris });
      return json(res, 201, { ...meta, client_id: clientId });
    }
    if (path === "/token" && req.method === "POST") return this.token(req, res);
    if (path === "/revoke" && req.method === "POST") {
      const form = new URLSearchParams(await body(req));
      const token = form.get("token") ?? "";
      this.revoked.push(token);
      const a = this.access.get(token);
      if (a !== undefined) a.valid = false;
      const r = this.refresh.get(token);
      if (r !== undefined) r.valid = false;
      res.writeHead(200).end();
      return;
    }
    if (path === "/userinfo") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const a = this.accessOf(token);
      if (a === undefined) return json(res, 401, { error: "invalid_token" });
      return json(res, 200, { sub: `sub-${a.account}`, email: a.account });
    }
    res.writeHead(404).end();
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await body(req));
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (
        code === undefined ||
        code.used ||
        code.expires < Date.now() ||
        code.client !== form.get("client_id") ||
        code.redirect !== form.get("redirect_uri") ||
        code.challenge !== s256(verifier) ||
        code.resource !== (form.get("resource") ?? "")
      ) {
        if (code !== undefined) code.used = true;
        return json(res, 400, { error: "invalid_grant" });
      }
      code.used = true;
      return json(res, 200, this.mint(code.account, code.scope, code.client, this.options.accessTtl));
    }
    if (grant === "refresh_token") {
      this.refreshCalls++;
      if (this.gate !== undefined) await this.gate;
      if (this.failRefresh === "server_error") return json(res, 500, { error: "server_error" });
      const old = form.get("refresh_token") ?? "";
      const r = this.refresh.get(old);
      if (this.failRefresh === "invalid_grant" || r === undefined || !r.valid) {
        return json(res, 400, { error: "invalid_grant" });
      }
      // A rotated refresh token is single use.
      if (this.options.rotate) r.valid = false;
      return json(res, 200, this.mint(r.account, r.scope, r.client, this.options.accessTtl, old));
    }
    json(res, 400, { error: "unsupported_grant_type" });
  }
}

export interface FakeMcpOptions {
  /** A scope the server needs for `tools/list`; a token without it gets 403 insufficient_scope. */
  requiredScope?: string;
}

/** The MCP resource server: protected resource metadata, and a JSON-RPC endpoint that wants a bearer token. */
export class FakeMcpServer {
  private server: Server | undefined;
  port = 0;
  /** The Authorization header of every request that reached /mcp. */
  seen: string[] = [];
  requiredScope: string | undefined;
  /** Refuse every token, as a service that revoked majhi behind the authorization server's back. */
  rejectAll = false;

  constructor(
    private readonly auth: FakeAuthServer,
    options: FakeMcpOptions = {},
  ) {
    this.requiredScope = options.requiredScope;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.port = await listen(this.server);
  }

  async stop(): Promise<void> {
    if (this.server !== undefined) await close(this.server);
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const meta = `http://127.0.0.1:${this.port}/.well-known/oauth-protected-resource/mcp`;
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, {
        resource: this.url,
        authorization_servers: [this.auth.url],
        bearer_methods_supported: ["header"],
      });
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const header = req.headers.authorization ?? "";
    this.seen.push(header);
    const access = this.auth.accessOf(header.replace(/^Bearer /, ""));
    if (access === undefined || this.rejectAll) {
      return json(
        res,
        401,
        { error: "unauthorized" },
        {
          "www-authenticate": `Bearer realm="OAuth", resource_metadata="${meta}"`,
        },
      );
    }
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    const message = JSON.parse(await body(req)) as { id?: number; method: string };
    if (this.requiredScope !== undefined && !access.scope.includes(this.requiredScope)) {
      return json(
        res,
        403,
        { error: "forbidden" },
        {
          "www-authenticate": `Bearer error="insufficient_scope", scope="${this.requiredScope}", resource_metadata="${meta}"`,
        },
      );
    }
    if (message.method === "initialize") {
      return json(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      return json(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            { name: "list_issues", description: "x", inputSchema: { type: "object" } },
            { name: "create_issue", description: "x", inputSchema: { type: "object" } },
          ],
        },
      });
    }
    res.writeHead(202).end();
  }
}

/** A catalog entry for the fake MCP server. */
export function fakeService(url: string, overrides: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: "fakesvc",
    name: "Fake Service",
    kind: "mcp-oauth",
    summary: "A fake service for tests",
    mcpUrl: url,
    ready: true,
    verified: false,
    verifiedNote: "A test double.",
    packs: [],
    scopes: [
      { id: "read", access: "read", sentence: "Read issues.", oauth: ["read"] },
      { id: "write", access: "write", sentence: "Create and change issues.", oauth: ["read", "write"] },
    ],
    test: { kind: "mcp-tools", sentence: "Lists the tools." },
    docs: "https://example.com/docs",
    ...overrides,
  };
}
