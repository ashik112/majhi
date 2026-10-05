import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServiceEntry, ServiceProvider } from "@majhi/shared";

/**
 * A fake provider with its own OAuth: authorization page (never opened, only read), token endpoint
 * (code with PKCE, refresh, device code), device-code endpoint, revocation and an identity call.
 * A real HTTP server on a loopback port, so the provider code under test makes real requests and no
 * test ever reaches a real service. `secretsSeen()` lists every token and code it made, for the
 * tests that assert none of them reaches a log.
 */

export interface FakeProviderOptions {
  /** Secret the token endpoint requires (a confidential client). */
  requireSecret?: string;
  /** Answers the device poll in order. After the list is used up it answers `ok`. */
  deviceScript?: ("pending" | "slow_down" | "denied" | "expired" | "ok")[];
  /** Leave the revoke endpoint out of the entry. */
  noRevoke?: boolean;
  accessTtl?: number;
  /** Send no refresh token (LinkedIn). */
  noRefresh?: boolean;
  /** The account the identity call reports. */
  account?: string;
  /** Say, as Google does for an app in Testing, that the refresh token ends in this many seconds. */
  refreshExpiresIn?: number;
}

interface Code {
  challenge: string | undefined;
  redirect: string;
  account: string;
  scope: string;
  used: boolean;
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export class FakeProvider {
  private server: Server | undefined;
  port = 0;
  readonly issued: string[] = [];
  private readonly codes = new Map<string, Code>();
  private readonly access = new Map<string, { account: string; valid: boolean }>();
  private readonly refresh = new Map<string, { account: string; scope: string; valid: boolean }>();
  private devicePolls = 0;
  tokenCalls = 0;
  refreshCalls = 0;
  deviceCalls = 0;
  revoked: { token: string; clientId: string; clientSecret: string | null }[] = [];
  lastTokenBody: URLSearchParams | undefined;
  /** Answer refresh with this error. */
  failRefresh: string | undefined;
  /**
   * Answer the identity call as Google does for an API that is off in the owner's project: a 403 with
   * SERVICE_DISABLED and the page that turns it on.
   */
  apiDisabled: { activationUrl?: string } | undefined;
  /** Register this challenge instead of the one the authorize URL carried (a swapped challenge). */
  swapChallenge: string | undefined;
  private gate: Promise<void> | undefined;
  private open: (() => void) | undefined;

  constructor(readonly options: FakeProviderOptions = {}) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    this.port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server === undefined ? r() : this.server.close(() => r())));
  }

  secretsSeen(): string[] {
    return [...this.issued];
  }

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.gate = undefined;
  }

  /** The owner approves the page the entry opened: where the browser would be sent back to. */
  approve(
    pageUrl: string,
    options: { account?: string; iss?: string | null; error?: string } = {},
  ): URLSearchParams {
    const page = new URL(pageUrl);
    const state = page.searchParams.get("state") ?? "";
    const back = new URLSearchParams({ state });
    if (options.error !== undefined) {
      back.set("error", options.error);
      return back;
    }
    const code = `code_${randomBytes(12).toString("hex")}`;
    this.issued.push(code);
    this.codes.set(code, {
      challenge: this.swapChallenge ?? page.searchParams.get("code_challenge") ?? undefined,
      redirect: page.searchParams.get("redirect_uri") ?? "",
      account: options.account ?? this.options.account ?? "maria@acme.example",
      scope: page.searchParams.get("scope") ?? "",
      used: false,
    });
    back.set("code", code);
    if (options.iss !== null && options.iss !== undefined) back.set("iss", options.iss);
    return back;
  }

  /** Marks every access token invalid, as a revoked grant does. */
  revokeAll(): void {
    for (const a of this.access.values()) a.valid = false;
  }

  private token(account: string, scope: string): Record<string, unknown> {
    const access = `at_${randomBytes(12).toString("hex")}`;
    this.issued.push(access);
    this.access.set(access, { account, valid: true });
    const out: Record<string, unknown> = {
      access_token: access,
      token_type: "Bearer",
      expires_in: this.options.accessTtl ?? 3600,
      scope,
    };
    if (this.options.refreshExpiresIn !== undefined) {
      out.refresh_token_expires_in = this.options.refreshExpiresIn;
    }
    if (this.options.noRefresh !== true) {
      const refresh = `rt_${randomBytes(12).toString("hex")}`;
      this.issued.push(refresh);
      this.refresh.set(refresh, { account, scope, valid: true });
      out.refresh_token = refresh;
    }
    return out;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", this.url).pathname;
    if (path === "/me") {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const held = this.access.get(token);
      if (held === undefined || !held.valid) return send(res, 401, { error: "invalid_token" });
      if (this.apiDisabled !== undefined) {
        return send(res, 403, {
          error: {
            code: 403,
            message: "Gmail API has not been used in project 123 before or it is disabled.",
            status: "PERMISSION_DENIED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "SERVICE_DISABLED",
                metadata:
                  this.apiDisabled.activationUrl === undefined
                    ? {}
                    : { activationUrl: this.apiDisabled.activationUrl },
              },
            ],
          },
        });
      }
      return send(res, 200, { email: held.account, sub: held.account });
    }
    const body = await readBody(req);
    if (path === "/device/code") {
      this.deviceCalls += 1;
      const deviceCode = `dc_${randomBytes(12).toString("hex")}`;
      this.issued.push(deviceCode);
      return send(res, 200, {
        device_code: deviceCode,
        user_code: "WDJB-MJHT",
        verification_uri: `${this.url}/device`,
        interval: 1,
        expires_in: 900,
      });
    }
    if (path === "/revoke") {
      this.revoked.push({
        token: body.get("token") ?? "",
        clientId: body.get("client_id") ?? "",
        clientSecret: body.get("client_secret"),
      });
      return send(res, 200, {});
    }
    if (path === "/token") {
      this.tokenCalls += 1;
      this.lastTokenBody = body;
      const secret = this.options.requireSecret;
      if (secret !== undefined && body.get("client_secret") !== secret) {
        return send(res, 401, { error: "invalid_client" });
      }
      const grant = body.get("grant_type");
      if (grant === "authorization_code") {
        const code = this.codes.get(body.get("code") ?? "");
        if (code === undefined || code.used) return send(res, 400, { error: "invalid_grant" });
        code.used = true;
        if (code.challenge !== undefined && s256(body.get("code_verifier") ?? "") !== code.challenge) {
          return send(res, 400, { error: "invalid_grant" });
        }
        if (code.redirect !== (body.get("redirect_uri") ?? ""))
          return send(res, 400, { error: "invalid_grant" });
        return send(res, 200, this.token(code.account, code.scope));
      }
      if (grant === "refresh_token") {
        this.refreshCalls += 1;
        if (this.gate !== undefined) await this.gate;
        if (this.failRefresh !== undefined) return send(res, 400, { error: this.failRefresh });
        const old = this.refresh.get(body.get("refresh_token") ?? "");
        if (old === undefined || !old.valid) return send(res, 400, { error: "invalid_grant" });
        old.valid = false;
        return send(res, 200, this.token(old.account, old.scope));
      }
      if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
        const step = this.options.deviceScript?.[this.devicePolls] ?? "ok";
        this.devicePolls += 1;
        if (step === "ok")
          return send(res, 200, this.token(this.options.account ?? "maria@acme.example", "read:user"));
        const error = {
          pending: "authorization_pending",
          slow_down: "slow_down",
          denied: "access_denied",
          expired: "expired_token",
        }[step];
        return send(res, 400, { error });
      }
    }
    send(res, 404, { error: "not_found" });
  }
}

/** A catalog entry whose provider is the fake. */
export function fakeProviderService(
  base: string,
  overrides: {
    flow?: "loopback" | "device";
    provider?: Partial<ServiceProvider>;
    entry?: Partial<ServiceEntry>;
  } = {},
): ServiceEntry {
  const flow = overrides.flow ?? "loopback";
  const provider: ServiceProvider = {
    flow,
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    deviceUrl: `${base}/device/code`,
    revokeUrl: `${base}/revoke`,
    issuerPrefix: false,
    issSent: false,
    pkce: true,
    clientAuth: "none",
    scopeSeparator: " ",
    identityScopes: ["openid"],
    extraAuthParams: {},
    identity: {
      url: `${base}/me`,
      method: "GET",
      labelPaths: [["email"]],
      idPaths: [["sub"]],
    },
    tokenVar: "FAKE_API_TOKEN",
    ...overrides.provider,
  };
  return {
    id: "fakeapi",
    name: "Fake API",
    kind: flow === "device" ? "device" : "oauth-loopback",
    summary: "A fake provider for tests",
    app: "fakeapp",
    ready: true,
    verified: false,
    verifiedNote: "A test double.",
    packs: ["Social and inbox"],
    provider,
    scopes: [
      { id: "read", access: "read", sentence: "Read mail.", oauth: ["mail.read"] },
      { id: "draft", access: "write", sentence: "Write drafts.", oauth: ["mail.draft"] },
      { id: "send", access: "write", level: "send", sentence: "Send mail.", oauth: ["mail.send"] },
    ],
    test: { kind: "api", sentence: "Asks who you are." },
    docs: "https://example.com/docs",
    ...overrides.entry,
  };
}
