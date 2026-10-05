import { createHash, randomBytes } from "node:crypto";
import type { ServiceProvider } from "@majhi/shared";
import { z } from "zod";
import { ConnectError, type Fetch, hostOf, type Identity, type TokenSet } from "./oauth.ts";

/**
 * OAuth 2.0 for providers with no MCP server (SPEC 5.14, "Connect"): authorization code with PKCE
 * S256 and a loopback redirect, and the device grant. Fetch only, no SDK: the MCP SDK adds the
 * `resource` parameter, which several of these providers refuse. As in `oauth.ts`, every failure
 * becomes a `ConnectError` with a sentence of majhi's own. A response body, a code or a token never
 * reaches a message, a log or a screen.
 */

export interface ProviderClient {
  clientId: string;
  /** The owner's own client secret, for the providers that need one. Never shipped. */
  clientSecret?: string | undefined;
}

export const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** The redirect address a provider is sent: majhi's own, with the provider's loopback name where it needs one. */
export function redirectFor(provider: ServiceProvider, redirect: string): string {
  if (provider.redirectHost === undefined) return redirect;
  const url = new URL(redirect);
  url.hostname = provider.redirectHost;
  return url.toString();
}

export function joinScope(provider: ServiceProvider, scopes: readonly string[]): string {
  return [...new Set([...scopes, ...provider.identityScopes])].join(provider.scopeSeparator);
}

/** The page the owner opens. */
export function authorizationPage(
  provider: ServiceProvider,
  client: ProviderClient,
  options: { redirect: string; scope: string; state: string; challenge: string | undefined },
): string {
  if (provider.authorizeUrl === undefined) {
    throw new ConnectError("This service has no sign-in page.", "unsupported");
  }
  const url = new URL(provider.authorizeUrl);
  const set = (k: string, v: string) => url.searchParams.set(k, v);
  set("response_type", "code");
  set("client_id", client.clientId);
  set("redirect_uri", redirectFor(provider, options.redirect));
  set("state", options.state);
  if (options.scope !== "") set("scope", options.scope);
  if (options.challenge !== undefined) {
    set("code_challenge", options.challenge);
    set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(provider.extraAuthParams)) set(k, v);
  return url.toString();
}

const ScopeSchema = z.union([z.string(), z.array(z.string())]);
const TokenBodySchema = z.object({
  access_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
  refresh_token_expires_in: z.union([z.number(), z.string()]).optional(),
  refresh_token: z.string().min(1).optional(),
  scope: ScopeSchema.optional(),
  id_token: z.string().optional(),
  error: z.string().optional(),
  interval: z.number().optional(),
});

/** OAuth error codes that mean the grant or the client is gone for good. */
const PERMANENT = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"]);

type Answer =
  | { ok: true; body: z.infer<typeof TokenBodySchema> }
  | { ok: false; error: string; status: number };

async function post(
  url: string,
  form: Record<string, string>,
  fetchFn: Fetch,
  authHeader?: string,
): Promise<Answer> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...(authHeader === undefined ? {} : { authorization: authHeader }),
      },
      body: new URLSearchParams(form),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ConnectError(
      `majhi could not reach ${hostOf(url)}. Check the connection and try again.`,
      "network",
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const parsed = TokenBodySchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: res.ok ? "protocol" : "server_error", status: res.status };
  }
  if (parsed.data.error !== undefined) return { ok: false, error: parsed.data.error, status: res.status };
  if (!res.ok) return { ok: false, error: "server_error", status: res.status };
  return { ok: true, body: parsed.data };
}

function toTokens(body: z.infer<typeof TokenBodySchema>, now: () => Date): TokenSet {
  const access = body.access_token;
  if (access === undefined) throw new ConnectError("The service sent no access token.", "protocol");
  const raw = body.scope;
  const scope =
    raw === undefined ? undefined : (Array.isArray(raw) ? raw : raw.split(/[\s,]+/)).filter((s) => s !== "");
  const seconds = body.expires_in === undefined ? Number.NaN : Number(body.expires_in);
  const refreshSeconds =
    body.refresh_token_expires_in === undefined ? Number.NaN : Number(body.refresh_token_expires_in);
  return {
    accessToken: access,
    refreshToken: body.refresh_token,
    expiresAt:
      Number.isFinite(seconds) && seconds > 0
        ? new Date(now().getTime() + seconds * 1000).toISOString()
        : undefined,
    scope,
    idToken: body.id_token,
    ...(Number.isFinite(refreshSeconds) && refreshSeconds > 0 ? { refreshExpiresIn: refreshSeconds } : {}),
  };
}

function failure(answer: Extract<Answer, { ok: false }>, url: string, hint?: string): ConnectError {
  const host = hostOf(url);
  if (PERMANENT.has(answer.error)) {
    return new ConnectError(
      `${host} no longer accepts this sign-in.${hint === undefined ? "" : ` ${hint}`}`,
      "refused",
    );
  }
  return new ConnectError(`${host} could not complete the sign-in just now. Try again.`, "network");
}

/** Client credentials as the provider wants them: in the body, never in a URL. */
function clientForm(provider: ServiceProvider, client: ProviderClient): Record<string, string> {
  return {
    client_id: client.clientId,
    ...(provider.clientAuth === "secret" && client.clientSecret !== undefined
      ? { client_secret: client.clientSecret }
      : {}),
  };
}

/** Redeems the code with the PKCE verifier. */
export async function exchangeCode(
  provider: ServiceProvider,
  client: ProviderClient,
  options: { code: string; verifier: string | undefined; redirect: string },
  fetchFn: Fetch,
  now: () => Date,
): Promise<TokenSet> {
  const answer = await post(
    provider.tokenUrl,
    {
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: redirectFor(provider, options.redirect),
      ...(options.verifier === undefined ? {} : { code_verifier: options.verifier }),
      ...clientForm(provider, client),
    },
    fetchFn,
  );
  if (!answer.ok) throw failure(answer, provider.tokenUrl);
  return toTokens(answer.body, now);
}

/** Trades the refresh token for new tokens. The old refresh token stays when none comes back. */
export async function refreshTokens(
  provider: ServiceProvider,
  client: ProviderClient,
  refreshToken: string,
  fetchFn: Fetch,
  now: () => Date,
): Promise<TokenSet> {
  const answer = await post(
    provider.tokenUrl,
    { grant_type: "refresh_token", refresh_token: refreshToken, ...clientForm(provider, client) },
    fetchFn,
  );
  if (!answer.ok) throw failure(answer, provider.tokenUrl, provider.refusedHint);
  return toTokens(answer.body, now);
}

// ---------------------------------------------------------------------------
// The device grant (RFC 8628)

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresInMs: number;
}

const DeviceBodySchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1).max(40),
  verification_uri: z.url(),
  interval: z.number().optional(),
  expires_in: z.number().optional(),
});

export async function startDevice(
  provider: ServiceProvider,
  client: ProviderClient,
  scope: string,
  fetchFn: Fetch,
): Promise<DeviceStart> {
  if (provider.deviceUrl === undefined)
    throw new ConnectError("This service has no device sign-in.", "unsupported");
  let res: Response;
  try {
    res = await fetchFn(provider.deviceUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: client.clientId, ...(scope === "" ? {} : { scope }) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ConnectError(
      `majhi could not reach ${hostOf(provider.deviceUrl)}. Check the connection and try again.`,
      "network",
    );
  }
  const json: unknown = await res.json().catch(() => undefined);
  const parsed = DeviceBodySchema.safeParse(json);
  if (!res.ok || !parsed.success) {
    throw new ConnectError(
      `${hostOf(provider.deviceUrl)} did not start a code sign-in. The app's client ID may be wrong, or device flow is off for it.`,
      "refused",
    );
  }
  return {
    deviceCode: parsed.data.device_code,
    userCode: parsed.data.user_code,
    verificationUri: parsed.data.verification_uri,
    intervalMs: Math.max(1, parsed.data.interval ?? 5) * 1000,
    expiresInMs: (parsed.data.expires_in ?? 900) * 1000,
  };
}

export type DevicePoll =
  | { kind: "tokens"; tokens: TokenSet }
  | { kind: "pending" }
  | { kind: "slow-down" }
  | { kind: "denied" }
  | { kind: "expired" };

export async function pollDevice(
  provider: ServiceProvider,
  client: ProviderClient,
  deviceCode: string,
  fetchFn: Fetch,
  now: () => Date,
): Promise<DevicePoll> {
  const answer = await post(
    provider.tokenUrl,
    {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      ...clientForm(provider, client),
    },
    fetchFn,
  );
  if (answer.ok) return { kind: "tokens", tokens: toTokens(answer.body, now) };
  switch (answer.error) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow-down" };
    case "access_denied":
      return { kind: "denied" };
    case "expired_token":
    case "token_expired":
      return { kind: "expired" };
    default:
      throw failure(answer, provider.tokenUrl);
  }
}

// ---------------------------------------------------------------------------
// Who signed in, and a read that proves the token works

const at = (value: unknown, path: readonly string[]): string | undefined => {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === "number") return String(cur);
  return typeof cur === "string" && cur.trim() !== "" && cur.length <= 200 ? cur.trim() : undefined;
};

export type ApiProbe =
  | { kind: "ok"; identity: Identity }
  | { kind: "invalid" }
  /**
   * A 403. `disabled` is set when the answer says the API is switched off for the owner's project
   * (Google's SERVICE_DISABLED), with the page that turns it on when the answer gives one.
   */
  | { kind: "forbidden"; disabled?: { url?: string | undefined } }
  | { kind: "unreachable" };

/** Pages Google's activation links may point at. Anything else is not shown as a link. */
const ACTIVATION_HOSTS: ReadonlySet<string> = new Set([
  "console.developers.google.com",
  "console.cloud.google.com",
]);

/**
 * Reads Google's 403 for "this API is not turned on in your project". The decision reads structured
 * fields (`error.details[].reason`, `error.errors[].reason`), never the message.
 */
export function apiDisabled(body: unknown): { url?: string | undefined } | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error !== "object" || error === null) return undefined;
  const details = (error as { details?: unknown }).details;
  const errors = (error as { errors?: unknown }).errors;
  let off = false;
  let url: string | undefined;
  for (const d of Array.isArray(details) ? details : []) {
    if (typeof d !== "object" || d === null) continue;
    if ((d as { reason?: unknown }).reason === "SERVICE_DISABLED") off = true;
    const meta = (d as { metadata?: unknown }).metadata;
    const link =
      typeof meta === "object" && meta !== null
        ? (meta as { activationUrl?: unknown }).activationUrl
        : undefined;
    if (typeof link === "string") {
      try {
        const parsed = new URL(link);
        if (parsed.protocol === "https:" && ACTIVATION_HOSTS.has(parsed.host)) url = parsed.toString();
      } catch {
        // Not a link.
      }
    }
  }
  for (const e of Array.isArray(errors) ? errors : []) {
    if (typeof e === "object" && e !== null && (e as { reason?: unknown }).reason === "accessNotConfigured")
      off = true;
  }
  return off ? { url } : undefined;
}

/** The provider's identity call with the token: who, and whether the token works. */
export async function probeProvider(
  provider: ServiceProvider,
  accessToken: string,
  fetchFn: Fetch,
): Promise<ApiProbe> {
  const id = provider.identity;
  try {
    const res = await fetchFn(id.url, {
      method: id.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(id.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(id.body === undefined ? {} : { body: id.body }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "invalid" };
    }
    if (res.status === 403) {
      const body: unknown = await res.json().catch(() => undefined);
      const disabled = apiDisabled(body);
      return disabled === undefined ? { kind: "forbidden" } : { kind: "forbidden", disabled };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "unreachable" };
    }
    const json: unknown = await res.json().catch(() => undefined);
    const label = id.labelPaths.map((p) => at(json, p)).find((v) => v !== undefined);
    const ident = id.idPaths.map((p) => at(json, p)).find((v) => v !== undefined);
    return { kind: "ok", identity: { id: ident ?? label, label: label ?? ident } };
  } catch {
    return { kind: "unreachable" };
  }
}
