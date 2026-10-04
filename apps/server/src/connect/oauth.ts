import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";

/**
 * The OAuth 2.1 client for remote MCP servers (SPEC 5.14), over the MCP SDK's discovery,
 * registration, PKCE and token calls. Every failure becomes a `ConnectError` with a sentence of
 * majhi's own: the SDK's messages can hold the service's raw answer, so they are dropped here and
 * nothing from a response body, a code or a token reaches a message, a log or a screen.
 */

export type Fetch = typeof fetch;

/**
 * - `network`: the service could not be reached; nothing is known about the grant.
 * - `refused`: the service said no for good (a bad or revoked grant, an unknown client).
 * - `unsupported`: the service does not offer what majhi needs.
 * - `protocol`: the service answered something that is not OAuth.
 */
export type ConnectErrorKind = "network" | "refused" | "unsupported" | "protocol";

/** A failure with a sentence safe to show. */
export class ConnectError extends Error {
  constructor(
    message: string,
    readonly kind: ConnectErrorKind,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "the service";
  }
};

/** What majhi learned about a server's sign-in. */
export interface Discovered {
  authorizationServerUrl: string;
  /** The issuer the tokens will be tied to. */
  issuer: string;
  metadata: AuthorizationServerMetadata;
  /** The `resource` for the authorization and token requests. */
  resource: string;
}

/** Finds how to sign in to the MCP server: protected resource metadata, then the authorization server's. */
export async function discover(serverUrl: string, fetchFn: Fetch): Promise<Discovered> {
  const host = hostOf(serverUrl);
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(serverUrl, { fetchFn });
  } catch {
    throw new ConnectError(`majhi could not reach ${host}. Check the connection and try again.`, "network");
  }
  const metadata = info.authorizationServerMetadata;
  if (metadata === undefined) {
    throw new ConnectError(
      `${host} does not say how to sign in to it, so majhi cannot connect it with one click.`,
      "unsupported",
    );
  }
  const requested = resourceUrlFromServerUrl(serverUrl);
  const advertised = info.resourceMetadata?.resource;
  let resource = requested.href;
  if (advertised !== undefined) {
    if (!checkResourceAllowed({ requestedResource: requested, configuredResource: advertised })) {
      throw new ConnectError(`${host} names a different server as its own, so majhi stopped.`, "protocol");
    }
    resource = advertised;
  }
  return {
    authorizationServerUrl: info.authorizationServerUrl,
    issuer: metadata.issuer,
    metadata,
    resource,
  };
}

/** The RFC 7009 revocation endpoint, which the SDK's two metadata shapes type differently. */
export function revocationEndpointOf(metadata: AuthorizationServerMetadata): string | undefined {
  const value = (metadata as { revocation_endpoint?: unknown }).revocation_endpoint;
  return typeof value === "string" ? value : undefined;
}

export interface RegisterOptions {
  redirect: string;
  /** The public address of majhi's client metadata document, when one is configured. */
  clientMetadataUrl?: string | undefined;
}

export interface ClientIdentity {
  clientId: string;
  clientSecret?: string | undefined;
  via: "dcr" | "cimd";
}

/** The authorization server tells whether it takes a client metadata document as a client ID. */
function takesMetadataDocument(metadata: AuthorizationServerMetadata): boolean {
  return (
    (metadata as { client_id_metadata_document_supported?: unknown })
      .client_id_metadata_document_supported === true
  );
}

/**
 * How majhi presents itself: its client metadata document when one is configured and the server
 * takes it, else dynamic registration as a native client with no secret asked for. Throws
 * `unsupported` for a server that offers neither.
 */
export async function register(
  found: Discovered,
  options: RegisterOptions,
  fetchFn: Fetch,
): Promise<ClientIdentity> {
  const host = hostOf(found.authorizationServerUrl);
  if (options.clientMetadataUrl !== undefined && takesMetadataDocument(found.metadata)) {
    return { clientId: options.clientMetadataUrl, via: "cimd" };
  }
  if (found.metadata.registration_endpoint === undefined) {
    throw new ConnectError(
      `${host} does not let majhi register itself. It needs an app made by hand, which comes in a later step.`,
      "unsupported",
    );
  }
  const methods = found.metadata.token_endpoint_auth_methods_supported;
  const method = methods === undefined || methods.includes("none") ? "none" : "client_secret_post";
  try {
    const registered = await registerClient(found.authorizationServerUrl, {
      metadata: found.metadata,
      fetchFn,
      // application_type is not in the SDK's type; the body carries what is given. OIDC servers
      // only take an http loopback redirect from a native client (MCP 2026-07-28).
      clientMetadata: {
        client_name: "majhi",
        redirect_uris: [options.redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: method,
        application_type: "native",
      } as never,
    });
    return { clientId: registered.client_id, clientSecret: registered.client_secret, via: "dcr" };
  } catch (err) {
    if (err instanceof OAuthError) {
      throw new ConnectError(`${host} refused majhi's registration. Try again later.`, "refused");
    }
    throw new ConnectError(`majhi could not reach ${host}. Check the connection and try again.`, "network");
  }
}

const info = (id: ClientIdentity, redirect: string): OAuthClientInformationMixed => ({
  client_id: id.clientId,
  ...(id.clientSecret === undefined ? {} : { client_secret: id.clientSecret }),
  redirect_uris: [redirect],
});

export interface AuthorizationStart {
  url: string;
  verifier: string;
}

/** The page the owner opens: PKCE S256, the `resource`, and the scope asked for. */
export async function authorizationUrl(
  found: Discovered,
  client: ClientIdentity,
  options: { redirect: string; scope: string | undefined; state: string },
): Promise<AuthorizationStart> {
  try {
    const started = await startAuthorization(found.authorizationServerUrl, {
      metadata: found.metadata,
      clientInformation: info(client, options.redirect),
      redirectUrl: options.redirect,
      state: options.state,
      resource: found.resource,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    });
    return { url: started.authorizationUrl.href, verifier: started.codeVerifier };
  } catch {
    throw new ConnectError(
      `${hostOf(found.authorizationServerUrl)} does not support the sign-in majhi needs (PKCE).`,
      "unsupported",
    );
  }
}

/** What the token endpoint gave, in majhi's shape. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: string | undefined;
  scope?: string[] | undefined;
  idToken?: string | undefined;
}

function tokenSet(tokens: OAuthTokens, now: () => Date): TokenSet {
  const scope = tokens.scope?.split(/\s+/).filter((s) => s !== "");
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt:
      tokens.expires_in === undefined || !Number.isFinite(tokens.expires_in)
        ? undefined
        : new Date(now().getTime() + tokens.expires_in * 1000).toISOString(),
    scope,
    idToken: tokens.id_token,
  };
}

/** OAuth error codes that mean the grant or the client is gone for good. */
const PERMANENT = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"]);

function tokenFailure(err: unknown, host: string): ConnectError {
  if (err instanceof OAuthError) {
    const code = (err as { errorCode?: string }).errorCode ?? "";
    if (PERMANENT.has(code)) {
      return new ConnectError(`${host} no longer accepts this sign-in.`, "refused");
    }
    // server_error, temporarily_unavailable, or an answer that was not OAuth: try again later.
    return new ConnectError(`${host} could not complete the sign-in just now. Try again.`, "network");
  }
  return new ConnectError(`majhi could not reach ${host}. Check the connection and try again.`, "network");
}

/** Redeems the code (with the PKCE verifier and the `resource`). */
export async function exchange(
  found: Discovered,
  client: ClientIdentity,
  options: { redirect: string; code: string; verifier: string },
  fetchFn: Fetch,
  now: () => Date,
): Promise<TokenSet> {
  try {
    const tokens = await exchangeAuthorization(found.authorizationServerUrl, {
      metadata: found.metadata,
      clientInformation: info(client, options.redirect),
      authorizationCode: options.code,
      codeVerifier: options.verifier,
      redirectUri: options.redirect,
      // Verbatim: URL.href adds "/" to a bare origin, which exact-match servers (DigitalOcean) refuse.
      resource: found.resource,
      fetchFn,
    });
    return tokenSet(tokens, now);
  } catch (err) {
    throw tokenFailure(err, hostOf(found.authorizationServerUrl));
  }
}

/** Trades the refresh token for new tokens. The old refresh token stays when the service sends no new one. */
export async function refresh(
  found: Discovered,
  client: ClientIdentity,
  options: { redirect: string; refreshToken: string },
  fetchFn: Fetch,
  now: () => Date,
): Promise<TokenSet> {
  try {
    const tokens = await refreshAuthorization(found.authorizationServerUrl, {
      metadata: found.metadata,
      clientInformation: info(client, options.redirect),
      refreshToken: options.refreshToken,
      // Verbatim: URL.href adds "/" to a bare origin, which exact-match servers (DigitalOcean) refuse.
      resource: found.resource,
      fetchFn,
    });
    return tokenSet(tokens, now);
  } catch (err) {
    throw tokenFailure(err, hostOf(found.authorizationServerUrl));
  }
}

/**
 * Asks the service to revoke a token (RFC 7009). True when it did. False when the service has no
 * revocation endpoint or did not take the call; the caller says what stays.
 */
export async function revoke(
  endpoint: string | undefined,
  client: { clientId: string; clientSecret?: string | undefined },
  token: { value: string; hint: "access_token" | "refresh_token" },
  fetchFn: Fetch,
): Promise<boolean> {
  if (endpoint === undefined) return false;
  const body = new URLSearchParams({
    token: token.value,
    token_type_hint: token.hint,
    client_id: client.clientId,
    ...(client.clientSecret === undefined ? {} : { client_secret: client.clientSecret }),
  });
  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Who signed in

export interface Identity {
  id?: string | undefined;
  label?: string | undefined;
}

function claims(jwt: string | undefined): Record<string, unknown> {
  if (jwt === undefined) return {};
  const part = jwt.split(".")[1];
  if (part === undefined) return {};
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" && value.length <= 200 ? value.trim() : undefined;

function fromClaims(c: Record<string, unknown>): Identity {
  const label = text(c.email) ?? text(c.preferred_username) ?? text(c.name) ?? text(c.username);
  const id = text(c.sub) ?? text(c.email);
  return { id, label: label ?? id };
}

/**
 * Who the token belongs to, from what the service already said: the ID token, the access token when
 * it is a JWT, or the userinfo endpoint. Empty when the service does not say, which majhi shows as
 * such rather than guessing.
 */
export async function identify(
  tokens: TokenSet,
  metadata: AuthorizationServerMetadata,
  fetchFn: Fetch,
): Promise<Identity> {
  for (const jwt of [tokens.idToken, tokens.accessToken]) {
    const found = fromClaims(claims(jwt));
    if (found.id !== undefined) return found;
  }
  const endpoint = (metadata as { userinfo_endpoint?: unknown }).userinfo_endpoint;
  if (typeof endpoint === "string") {
    try {
      const res = await fetchFn(endpoint, {
        headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const body: unknown = await res.json();
        if (typeof body === "object" && body !== null) return fromClaims(body as Record<string, unknown>);
      }
    } catch {
      // The service did not say who. That is shown as such.
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// What the server says about a token

export type TokenProbe =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "insufficient-scope"; scope: string[] }
  | { kind: "unreachable" }
  /** The service took the call and gave no answer in time. */
  | { kind: "slow" }
  /** The service answered, and refused or failed: its status and a short reason (never the token). */
  | { kind: "other"; status: number; reason: string };

/**
 * One unauthenticated-looking call to the MCP server with the token: tells a working token from a
 * revoked one (401) and from one that lacks a permission (403 insufficient_scope, RFC 6750), and
 * reads the scope the server names. The call is `initialize`, which changes nothing.
 */
export async function probeToken(
  url: string,
  token: string,
  fetchFn: Fetch,
  timeoutMs = 15_000,
): Promise<TokenProbe> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "majhi", version: "1" },
        },
      }),
      // A server that sends an unentitled account to a sign-in page answers with a redirect.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "ok" };
    }
    const body = await res.text().then(
      (t) => t.slice(0, 2000),
      () => "",
    );
    if (res.status === 401) return { kind: "invalid" };
    if (res.status >= 300 && res.status < 400) {
      return { kind: "other", status: res.status, reason: redirectReason(res.headers.get("location"), url) };
    }
    if (res.status === 403) {
      const header = res.headers.get("www-authenticate") ?? "";
      if (/error="?insufficient_scope"?/i.test(header)) {
        const scope =
          /scope="([^"]*)"/i
            .exec(header)?.[1]
            ?.split(/\s+/)
            .filter((s) => s !== "") ?? [];
        return { kind: "insufficient-scope", scope };
      }
    }
    return {
      kind: "other",
      status: res.status,
      reason: refusalReason(res.headers.get("www-authenticate"), body),
    };
  } catch (err) {
    return err instanceof DOMException && err.name === "TimeoutError"
      ? { kind: "slow" }
      : { kind: "unreachable" };
  }
}

/** Where a redirect went, as host and path: never its query, which can carry a token. */
function redirectReason(location: string | null, base: string): string {
  if (location === null) return "it answered with a redirect";
  try {
    const to = new URL(location, base);
    return `it sent majhi to ${to.host}${to.pathname === "/" ? "" : to.pathname}`.slice(0, 200);
  } catch {
    return "it answered with a redirect";
  }
}

/** A short, one-line reason from an error answer: a JSON error message, else the WWW-Authenticate text. Max 200 chars. */
export function refusalReason(header: string | null, body: string): string {
  let text = "";
  try {
    const json: unknown = JSON.parse(body);
    if (json !== null && typeof json === "object") {
      const o = json as Record<string, unknown>;
      const err = o.error;
      const pick = [o.error_description, o.message, typeof err === "string" ? err : undefined, o.detail];
      const nested =
        err !== null && typeof err === "object" ? (err as Record<string, unknown>).message : undefined;
      text = [nested, ...pick].find((v): v is string => typeof v === "string" && v !== "") ?? "";
    }
  } catch {
    // Not JSON: use the header.
  }
  if (text === "" && header !== null) {
    text = /error_description="([^"]*)"/i.exec(header)?.[1] ?? /error="?([a-z_]+)"?/i.exec(header)?.[1] ?? "";
  }
  return text
    .replace(/\bBearer\s+\S+/gi, "Bearer ***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
