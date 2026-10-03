import { type GitAuth, type MrHost, type OAuthGrant, OAuthGrantSchema, type OrgConfig } from "@majhi/shared";
import type { Fetch } from "./http.ts";
import { TokenRefused } from "./http.ts";
import { refreshToken } from "./oauth.ts";

/** Refresh an access token when less than this is left. */
export const REFRESH_BEFORE_MS = 10 * 60_000;

const nameOf = (ref: string) => ref.replace(/^secret:/, "");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Where a workspace's credential for one host lives in majhi.yaml. */
export interface OrgCredential {
  kind: MrHost;
  host: string;
  /** The git account bound to the host, when there is one. */
  account?: string;
  /** `secret:<name>` of the token: the git account's, else `mr_tokens[kind]`. */
  tokenRef?: string;
  /** `secret:<name>` of the OAuth grant, when the token came from signing in. */
  oauthRef?: string;
  /** The git account's SSH route: an alias, or `default` for the host name itself. */
  ssh?: string;
}

/** The workspace's credential for a host: its git account there first, then `mr_tokens[kind]`. */
export function credentialOf(org: OrgConfig | undefined, kind: MrHost, host: string): OrgCredential {
  const accounts = (org?.git_accounts ?? []).filter((a) => a.host === host);
  const entry = accounts.find((a) => a.token !== undefined) ?? accounts[0];
  const tokenRef = entry?.token ?? org?.mr_tokens?.[kind];
  return {
    kind,
    host,
    ...(entry === undefined ? {} : { account: entry.account }),
    ...(tokenRef === undefined ? {} : { tokenRef }),
    ...(entry?.token !== undefined && entry.oauth !== undefined ? { oauthRef: entry.oauth } : {}),
    ...(entry?.ssh === undefined ? {} : { ssh: entry.ssh }),
  };
}

/**
 * The user name git sends with a token over https, and the password. The token never goes in a URL.
 * - GitHub: `x-access-token`.
 * - GitLab: `oauth2` (works for OAuth and personal access tokens).
 * - Bitbucket OAuth token: `x-token-auth`.
 * - Bitbucket API token saved as `email:token`: the static `x-bitbucket-api-token-auth` and the token
 *   (https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/).
 */
export function tokenAuth(kind: MrHost, token: string): Extract<GitAuth, { kind: "token" }> {
  if (kind === "github") return { kind: "token", username: "x-access-token", password: token };
  if (kind === "gitlab") return { kind: "token", username: "oauth2", password: token };
  const at = token.indexOf(":");
  return at === -1
    ? { kind: "token", username: "x-token-auth", password: token }
    : { kind: "token", username: "x-bitbucket-api-token-auth", password: token.slice(at + 1) };
}

export interface GitTokensDeps {
  orgs: () => Promise<Record<string, OrgConfig>>;
  secrets: {
    get(name: string): Promise<string | undefined>;
    set(name: string, value: string): Promise<void>;
  };
  fetch: Fetch;
  now?: () => number;
}

export type TokenUse<T> =
  | { state: "ok"; value: T; account: string | undefined }
  | { state: "signed-out" }
  | { state: "refused"; account: string };

/**
 * Reads a workspace's token for a host, refreshing a signed-in GitLab token first
 * when it is about to expire. A refresh rewrites the token and the grant in `secrets.age` in place,
 * so majhi.yaml never changes. Refreshes of one token run one at a time.
 */
export class GitTokens {
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly deps: GitTokensDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The workspace's credential for a host, as majhi.yaml has it now. */
  async credential(org: string, kind: MrHost, host: string): Promise<OrgCredential> {
    return credentialOf((await this.deps.orgs())[org], kind, host);
  }

  /**
   * The value of a token reference, refreshed first when a grant names it and less than ten minutes
   * are left (or always with `force`). Undefined when there is no such secret.
   */
  async value(tokenRef: string, options: { force?: boolean } = {}): Promise<string | undefined> {
    const oauthRef = await this.grantRefOf(tokenRef);
    if (oauthRef !== undefined) {
      const grant = await this.grant(oauthRef);
      if (
        grant !== undefined &&
        (options.force === true || Date.parse(grant.expiresAt) - this.now() < REFRESH_BEFORE_MS)
      ) {
        return this.refresh(tokenRef, oauthRef, grant);
      }
    }
    return this.deps.secrets.get(nameOf(tokenRef));
  }

  /**
   * Runs `use` with the workspace's token for a host. When the host refuses it and it came from
   * signing in, majhi refreshes once and tries again; a second refusal answers `refused`.
   */
  async withToken<T>(
    org: string,
    kind: MrHost,
    host: string,
    use: (token: string, account: string | undefined) => Promise<T>,
  ): Promise<TokenUse<T>> {
    const cred = await this.credential(org, kind, host);
    if (cred.tokenRef === undefined) return { state: "signed-out" };
    const account = cred.account;
    let token: string | undefined;
    try {
      token = await this.value(cred.tokenRef);
    } catch (err) {
      if (err instanceof TokenRefused) return { state: "refused", account: account ?? "" };
      throw err;
    }
    if (token === undefined) return { state: "signed-out" };
    try {
      return { state: "ok", value: await use(token, account), account };
    } catch (err) {
      if (!(err instanceof TokenRefused)) throw err;
      if (cred.oauthRef === undefined) return { state: "refused", account: account ?? "" };
    }
    try {
      const again = await this.value(cred.tokenRef, { force: true });
      if (again === undefined) return { state: "signed-out" };
      return { state: "ok", value: await use(again, account), account };
    } catch (err) {
      if (err instanceof TokenRefused) return { state: "refused", account: account ?? "" };
      throw err;
    }
  }

  /** The `oauth` ref of the git account whose token this is, in any org. */
  private async grantRefOf(tokenRef: string): Promise<string | undefined> {
    for (const org of Object.values(await this.deps.orgs())) {
      for (const a of org.git_accounts ?? []) {
        if (a.token === tokenRef && a.oauth !== undefined) return a.oauth;
      }
    }
    return undefined;
  }

  private async grant(oauthRef: string): Promise<OAuthGrant | undefined> {
    const text = await this.deps.secrets.get(nameOf(oauthRef));
    if (text === undefined) return undefined;
    try {
      const parsed = OAuthGrantSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private refresh(tokenRef: string, oauthRef: string, grant: OAuthGrant): Promise<string> {
    const running = this.inFlight.get(tokenRef);
    if (running !== undefined) return running;
    const task = (async () => {
      // Another refresh may have finished while this one waited: read the grant again.
      const current = (await this.grant(oauthRef)) ?? grant;
      // Only GitLab grants are refreshed. A Bitbucket OAuth grant from an older majhi has no
      // consumer any more: the owner signs in again with an API token.
      if (current.kind !== "gitlab") {
        throw new TokenRefused(`${current.host} needs a new sign-in for this workspace.`);
      }
      const answer = await refreshToken(
        this.deps.fetch,
        current.host,
        current.clientId,
        current.refreshToken,
      );
      const next: OAuthGrant = {
        ...current,
        // GitLab rotates the refresh token on every refresh: keep the new one at once.
        refreshToken: answer.refresh_token ?? current.refreshToken,
        expiresAt: new Date(this.now() + (answer.expires_in ?? 7200) * 1000).toISOString(),
      };
      await this.deps.secrets.set(nameOf(oauthRef), JSON.stringify(next));
      await this.deps.secrets.set(nameOf(tokenRef), answer.access_token);
      return answer.access_token;
    })();
    this.inFlight.set(tokenRef, task);
    return task.finally(() => this.inFlight.delete(tokenRef));
  }
}

/** Other workspaces that use this account on this host. */
export function alsoUsedBy(
  orgs: Record<string, OrgConfig>,
  self: string,
  host: string,
  account: string,
): string[] {
  return Object.entries(orgs)
    .filter(
      ([id, o]) =>
        id !== self && (o.git_accounts ?? []).some((a) => a.host === host && same(a.account, account)),
    )
    .map(([id]) => id)
    .sort();
}
