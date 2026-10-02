import type { MrHost } from "@majhi/shared";
import { z } from "zod";
import { call, type Fetch, HostUnreachable, TokenRefused } from "./http.ts";

/**
 * The OAuth calls of each git host: the device flow (GitHub, GitLab), the authorization code
 * exchange (Bitbucket), refreshing, the user check and revoking. Every answer is parsed with zod.
 * Nothing here logs, and no error holds a token, a code or a body.
 *
 * Docs:
 * - GitHub device flow: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 * - GitLab device grant (17.2, on by default in 17.3, GA in 17.9): https://docs.gitlab.com/api/oauth2/
 * - Bitbucket OAuth 2.0: https://developer.atlassian.com/cloud/bitbucket/rest/intro/#oauth-2-0
 */

export const GITHUB_SCOPE = "repo read:org workflow";
export const GITLAB_SCOPE = "api";
export const BITBUCKET_AUTHORIZE = "https://bitbucket.org/site/oauth2/authorize";
export const BITBUCKET_TOKEN = "https://bitbucket.org/site/oauth2/access_token";

const DeviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  verification_uri_complete: z.url().optional(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().optional(),
});
export type DeviceCode = z.infer<typeof DeviceCodeSchema>;

const TokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
  scopes: z.string().optional(),
});
export type TokenAnswer = z.infer<typeof TokenSchema>;

const OAuthErrorSchema = z.object({ error: z.string() });

/** What one device-flow poll learned. */
export type DevicePoll =
  | { state: "token"; token: TokenAnswer }
  | { state: "pending" }
  | { state: "slow-down" }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "failed"; reason: string };

function deviceUrls(kind: "github" | "gitlab", host: string): { code: string; token: string } {
  return kind === "github"
    ? { code: "https://github.com/login/device/code", token: "https://github.com/login/oauth/access_token" }
    : { code: `https://${host}/oauth/authorize_device`, token: `https://${host}/oauth/token` };
}

/**
 * Starts a device flow. Throws `HostUnreachable` with a plain sentence when the host does not
 * offer it (an old GitLab answers 404) or refuses the client ID.
 */
export async function startDevice(
  fetchFn: Fetch,
  kind: "github" | "gitlab",
  host: string,
  clientId: string,
): Promise<DeviceCode> {
  const answer = await call(fetchFn, deviceUrls(kind, host).code, {
    form: { client_id: clientId, scope: kind === "github" ? GITHUB_SCOPE : GITLAB_SCOPE },
  });
  const parsed = DeviceCodeSchema.safeParse(answer.body);
  if (answer.status >= 200 && answer.status < 300 && parsed.success) return parsed.data;
  if (kind === "gitlab" && (answer.status === 404 || answer.status === 405)) {
    throw new HostUnreachable(
      `${host} does not offer sign-in from majhi. It needs GitLab 17.3 or later. Paste a personal access token with the api scope instead.`,
    );
  }
  const error = OAuthErrorSchema.safeParse(answer.body);
  if (
    error.success &&
    (error.data.error === "invalid_client" || error.data.error === "unauthorized_client")
  ) {
    throw new HostUnreachable(
      kind === "github"
        ? "GitHub did not accept majhi's client ID, or Device Flow is not enabled on the app. Check the app's settings."
        : `${host} did not accept majhi's application ID. Check the application on ${host}.`,
    );
  }
  if (error.success && error.data.error === "device_flow_disabled") {
    throw new HostUnreachable(
      "Device Flow is not enabled on the GitHub app. Tick Enable Device Flow on its page.",
    );
  }
  throw new HostUnreachable(`${host} did not start the sign-in (answer ${answer.status}). Try again.`);
}

/** One poll of the token endpoint. Never throws: an unreachable host counts as still pending. */
export async function pollDevice(
  fetchFn: Fetch,
  kind: "github" | "gitlab",
  host: string,
  clientId: string,
  deviceCode: string,
): Promise<DevicePoll> {
  let answer: Awaited<ReturnType<typeof call>>;
  try {
    answer = await call(fetchFn, deviceUrls(kind, host).token, {
      form: {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
    });
  } catch {
    return { state: "pending" };
  }
  const token = TokenSchema.safeParse(answer.body);
  if (answer.status >= 200 && answer.status < 300 && token.success)
    return { state: "token", token: token.data };
  const error = OAuthErrorSchema.safeParse(answer.body);
  if (!error.success) {
    return answer.status >= 500
      ? { state: "pending" }
      : { state: "failed", reason: `${host} answered ${answer.status}.` };
  }
  switch (error.data.error) {
    case "authorization_pending":
      return { state: "pending" };
    case "slow_down":
      return { state: "slow-down" };
    case "access_denied":
      return { state: "denied" };
    case "expired_token":
    case "token_expired":
      return { state: "expired" };
    default:
      return { state: "failed", reason: `${host} ended the sign-in (${error.data.error.slice(0, 60)}).` };
  }
}

/** The Bitbucket page the owner allows majhi on. Holds the consumer key and the one-time state only. */
export function bitbucketAuthorizeUrl(key: string, state: string): string {
  const url = new URL(BITBUCKET_AUTHORIZE);
  url.searchParams.set("client_id", key);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

/** Exchanges a Bitbucket authorization code. Throws `TokenRefused` or `HostUnreachable`. */
export async function bitbucketExchange(
  fetchFn: Fetch,
  consumer: { key: string; secret: string },
  code: string,
): Promise<TokenAnswer> {
  return tokenCall(fetchFn, BITBUCKET_TOKEN, "bitbucket.org", {
    headers: { authorization: basic(consumer.key, consumer.secret) },
    form: { grant_type: "authorization_code", code },
  });
}

/**
 * Refreshes an access token. GitLab: a public client sends its client ID only. Bitbucket: Basic
 * with the consumer. Throws `TokenRefused` when the refresh token is no longer good
 * (`invalid_grant`), `HostUnreachable` otherwise.
 */
export async function refreshToken(
  fetchFn: Fetch,
  kind: Exclude<MrHost, "github">,
  host: string,
  client: { clientId: string; secret?: string | undefined },
  refresh: string,
): Promise<TokenAnswer> {
  if (kind === "bitbucket") {
    if (client.secret === undefined) throw new TokenRefused("The Bitbucket consumer's secret is missing.");
    return tokenCall(fetchFn, BITBUCKET_TOKEN, host, {
      headers: { authorization: basic(client.clientId, client.secret) },
      form: { grant_type: "refresh_token", refresh_token: refresh },
    });
  }
  return tokenCall(fetchFn, `https://${host}/oauth/token`, host, {
    form: { grant_type: "refresh_token", refresh_token: refresh, client_id: client.clientId },
  });
}

async function tokenCall(
  fetchFn: Fetch,
  url: string,
  host: string,
  req: { headers?: Record<string, string>; form: Record<string, string> },
): Promise<TokenAnswer> {
  const answer = await call(fetchFn, url, req);
  const token = TokenSchema.safeParse(answer.body);
  if (answer.status >= 200 && answer.status < 300 && token.success) return token.data;
  const error = OAuthErrorSchema.safeParse(answer.body);
  if (
    answer.status === 401 ||
    (error.success && ["invalid_grant", "invalid_client", "unauthorized_client"].includes(error.data.error))
  ) {
    throw new TokenRefused(`${host} no longer accepts majhi's sign-in for this workspace. Sign in again.`);
  }
  throw new HostUnreachable(`${host} did not answer the sign-in (answer ${answer.status}). Try again.`);
}

/** The API base and user call of each host. */
export function userRequest(
  kind: MrHost,
  host: string,
  token: string,
): { url: string; headers: Record<string, string>; field: "login" | "username" } {
  if (kind === "github") {
    return {
      url: "https://api.github.com/user",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      field: "login",
    };
  }
  if (kind === "bitbucket") {
    return {
      url: "https://api.bitbucket.org/2.0/user",
      headers: { authorization: bitbucketAuth(token) },
      field: "username",
    };
  }
  return {
    url: `https://${host}/api/v4/user`,
    headers: { authorization: `Bearer ${token}` },
    field: "username",
  };
}

/** Bitbucket: `email:api-token` is Basic, an OAuth or access token is Bearer. */
export function bitbucketAuth(token: string): string {
  const at = token.indexOf(":");
  return at === -1 ? `Bearer ${token}` : basic(token.slice(0, at), token.slice(at + 1));
}

/** Who a token belongs to. Throws `TokenRefused` or `HostUnreachable`. */
export async function whoAmI(fetchFn: Fetch, kind: MrHost, host: string, token: string): Promise<string> {
  const req = userRequest(kind, host, token);
  const answer = await call(fetchFn, req.url, { headers: req.headers });
  if (answer.status === 401 || answer.status === 403) throw new TokenRefused(`${host} refused the token.`);
  const user = z.object({ [req.field]: z.string().min(1) }).safeParse(answer.body);
  if (answer.status < 200 || answer.status >= 300 || !user.success) {
    throw new HostUnreachable(`majhi could not check the account on ${host}. Try again.`);
  }
  return String(user.data[req.field]);
}

/** Where the owner removes majhi's access by hand, for hosts majhi cannot revoke on. */
export function revokePage(kind: MrHost, host: string): string {
  if (kind === "github") return "https://github.com/settings/applications";
  if (kind === "bitbucket") return "https://bitbucket.org/account/settings/app-authorizations/";
  return `https://${host}/-/user_settings/applications`;
}

/**
 * Revokes a token at the host where majhi can: GitLab's `/oauth/revoke` takes a public client's ID.
 * GitHub's revoke needs the app's client secret, which majhi never has; Bitbucket documents no
 * revoke endpoint. Answers what happened and never throws.
 */
export async function revoke(
  fetchFn: Fetch,
  kind: MrHost,
  host: string,
  token: string,
  clientId: string | undefined,
): Promise<"revoked" | "local" | "failed"> {
  if (kind !== "gitlab" || clientId === undefined) return "local";
  try {
    const answer = await call(fetchFn, `https://${host}/oauth/revoke`, {
      form: { client_id: clientId, token },
    });
    return answer.status >= 200 && answer.status < 300 ? "revoked" : "failed";
  } catch {
    return "failed";
  }
}
