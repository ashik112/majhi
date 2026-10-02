import {
  type GitAccount,
  type GitHost,
  type GitHostLogins,
  type MrHost,
  normalizeSshRoute,
} from "@majhi/shared";
import { UserError } from "../errors.ts";

/** One authenticated call to a host's API: its status and, when it answered 2xx, its JSON body. */
export type Probe = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;

/** The real probe: no redirects, eight seconds at most. The headers carry the token and are never logged. */
export const fetchProbe: Probe = async (url, headers) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000), redirect: "error" });
  const body: unknown = res.ok ? await res.json().catch(() => undefined) : undefined;
  return { status: res.status, body };
};

/** The `mr_tokens` key of a host kind. A host majhi does not know is treated as self-hosted GitLab. */
export const mrKindOf = (kind: GitHost): MrHost => (kind === "other" ? "gitlab" : kind);

/**
 * The value saved for a token and the API call that proves it: GitHub `/user`, GitLab `/api/v4/user`,
 * Bitbucket `/2.0/user` with `username:app-password`.
 */
export function tokenRequest(
  host: string,
  kind: GitHost,
  account: string,
  secret: string,
): { kind: MrHost; url: string; headers: Record<string, string>; value: string } {
  const mr = mrKindOf(kind);
  if (mr === "github") {
    return {
      kind: mr,
      url: "https://api.github.com/user",
      headers: { authorization: `Bearer ${secret}`, accept: "application/vnd.github+json" },
      value: secret,
    };
  }
  if (mr === "bitbucket") {
    const value = secret.includes(":") ? secret : `${account}:${secret}`;
    return {
      kind: mr,
      url: "https://api.bitbucket.org/2.0/user",
      headers: { authorization: `Basic ${Buffer.from(value).toString("base64")}` },
      value,
    };
  }
  return {
    kind: mr,
    url: `https://${host}/api/v4/user`,
    headers: { authorization: `Bearer ${secret}` },
    value: secret,
  };
}

/** The user a token belongs to: GitHub's `login`, GitLab's and Bitbucket's `username`. */
function userOf(kind: MrHost, body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[kind === "github" ? "login" : "username"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export type TokenCheck = { state: "ok"; as: string } | { state: "refused" } | { state: "unreachable" };

/** Asks the host who a token belongs to. Never throws and never puts the token in its answer. */
export async function checkToken(
  probe: Probe,
  request: { kind: MrHost; url: string; headers: Record<string, string> },
): Promise<TokenCheck> {
  let answer: { status: number; body: unknown };
  try {
    answer = await probe(request.url, request.headers);
  } catch {
    return { state: "unreachable" };
  }
  if (answer.status === 401 || answer.status === 403) return { state: "refused" };
  if (answer.status < 200 || answer.status >= 300) return { state: "unreachable" };
  const as = userOf(request.kind, answer.body);
  return as === undefined ? { state: "refused" } : { state: "ok", as };
}

export interface GitAccountDeps {
  org: (id: string) => Promise<
    | {
        identity?: { name: string; email: string } | undefined;
        accounts: GitAccount[];
        mrTokens?: Partial<Record<MrHost, string>> | undefined;
      }
    | undefined
  >;
  /** The Mac's detected logins per host. Empty when the helper is not connected. */
  logins: () => Promise<readonly GitHostLogins[]>;
  /** Adopts the gh or glab token of the login into this org only, and returns its secret ref. */
  adopt: (via: "gh" | "glab", host: string) => Promise<string>;
  saveSecret: (input: { value: string; label: string }) => Promise<{ ref: string }>;
  /** Public name and email of the account on its host, when the host tells. */
  publicProfile: (host: string, account: string) => Promise<{ name: string; email: string } | undefined>;
  /** Proves a pasted token before it is saved. */
  probe: Probe;
  classify: (host: string) => GitHost;
  write: (
    id: string,
    patch: {
      git_accounts: GitAccount[];
      identity?: { name: string; email: string };
      mr_tokens?: Partial<Record<MrHost, string>>;
    },
  ) => Promise<void>;
}

/** The identity to set: only when the org has none and the host knows both fields. Never replaces one. */
export function identityToFill(
  current: { name: string; email: string } | undefined,
  profile: { name: string; email: string } | undefined,
): { name: string; email: string } | undefined {
  return current === undefined ? profile : undefined;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Checks a pasted token with the host before anything is saved. Throws a plain sentence when the
 * host refuses it, cannot be reached, or names another user.
 */
async function verifiedToken(
  deps: Pick<GitAccountDeps, "probe" | "classify">,
  host: string,
  account: string,
  token: string,
): Promise<{ kind: MrHost; value: string }> {
  const request = tokenRequest(host, deps.classify(host), account, token.trim());
  const check = await checkToken(deps.probe, request);
  if (check.state === "unreachable") {
    throw new UserError(`majhi could not reach ${host} to check the token. Nothing was saved. Try again.`);
  }
  if (check.state === "refused") {
    throw new UserError(
      `${host} did not accept this token. Make a new one while logged in as ${account}, and paste all of it.`,
    );
  }
  if (!same(check.as, account)) {
    throw new UserError(
      `This token belongs to ${check.as}, not ${account}. Log in to ${host} as ${account} and make it there.`,
    );
  }
  return { kind: request.kind, value: request.value };
}

/** Binds one git account to one org. Only this org's config and secrets change. */
export async function setGitAccount(
  deps: GitAccountDeps,
  input: { id: string; host: string; account: string; ssh?: string | undefined; token?: string | undefined },
): Promise<void> {
  const org = await deps.org(input.id);
  if (org === undefined) throw new UserError(`Org "${input.id}" does not exist.`, 404);
  const host = input.host.trim().toLowerCase();
  const previous = org.accounts.find((a) => a.host === host && same(a.account, input.account));
  let token = previous?.token;
  let mr_tokens: Partial<Record<MrHost, string>> | undefined;
  if (input.token !== undefined) {
    // The host must accept it first: a token that does not work is never saved.
    const { kind, value } = await verifiedToken(deps, host, input.account, input.token);
    token = (await deps.saveSecret({ value, label: `${input.id} ${host} ${input.account} token` })).ref;
    mr_tokens = { ...(org.mrTokens ?? {}), [kind]: token };
  } else if (token === undefined) {
    const login = (await deps.logins().catch(() => []))
      .find((h) => h.host === host)
      ?.logins.find((l) => l.via !== "ssh" && same(l.account, input.account));
    if (login !== undefined && login.via !== "ssh") token = await deps.adopt(login.via, host);
  }
  const ssh = normalizeSshRoute(host, input.ssh ?? previous?.ssh);
  const entry: GitAccount = {
    host,
    account: input.account,
    ...(ssh === undefined ? {} : { ssh }),
    ...(token === undefined ? {} : { token }),
  };
  const git_accounts = [
    ...org.accounts.filter((a) => !(a.host === host && same(a.account, input.account))),
    entry,
  ];
  const fill =
    org.identity === undefined
      ? identityToFill(org.identity, await deps.publicProfile(host, input.account).catch(() => undefined))
      : undefined;
  await deps.write(input.id, {
    git_accounts,
    ...(fill === undefined ? {} : { identity: fill }),
    ...(mr_tokens === undefined ? {} : { mr_tokens }),
  });
}

/** The public name and email of an account on GitHub or GitLab. Undefined when absent or unreachable. */
export async function fetchPublicProfile(
  host: string,
  account: string,
  get: (url: string) => Promise<unknown> = async (url) => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
    return res.ok ? ((await res.json()) as unknown) : undefined;
  },
): Promise<{ name: string; email: string } | undefined> {
  const name = encodeURIComponent(account);
  const isGithub = host === "github.com";
  const body = await get(
    isGithub ? `https://api.github.com/users/${name}` : `https://${host}/api/v4/users?username=${name}`,
  );
  const user = (Array.isArray(body) ? body[0] : body) as
    | { name?: unknown; email?: unknown; public_email?: unknown }
    | undefined;
  const email = isGithub ? user?.email : user?.public_email;
  if (typeof email !== "string" || !email.includes("@")) return undefined;
  return { name: typeof user?.name === "string" && user.name !== "" ? user.name : account, email };
}

export interface SavedLoginDeps {
  org: GitAccountDeps["org"];
  /** Asks the Mac's git credential helper for the saved secret of an account. Throws a safe sentence. */
  readSecret: (host: string, account: string) => Promise<string>;
  probe: Probe;
  saveSecret: GitAccountDeps["saveSecret"];
  /** Writes this org's account list and `mr_tokens` entry. */
  write: (
    id: string,
    patch: { git_accounts: GitAccount[]; mr_token: { host: MrHost; ref: string } },
  ) => Promise<void>;
}

/**
 * Whether the Mac saved a login for the account, and whether the host's API takes it as a token.
 * A silent check for showing a button: it never throws and never says why.
 */
export async function checkSavedLogin(
  deps: Pick<SavedLoginDeps, "readSecret" | "probe">,
  host: string,
  kind: GitHost,
  account: string,
): Promise<"none" | "login" | "token"> {
  let secret: string;
  try {
    secret = await deps.readSecret(host, account);
  } catch {
    return "none";
  }
  const check = await checkToken(deps.probe, tokenRequest(host, kind, account, secret));
  return check.state === "ok" && same(check.as, account) ? "token" : "login";
}

/**
 * Adopts the Mac's saved https login (Keychain or `gh`) as the account's token, only for the chosen
 * org and only when the host's API accepts it. An account password or a stale login is refused with
 * a plain sentence. The secret is never returned or logged.
 */
export async function useSavedLogin(
  deps: SavedLoginDeps,
  classify: (host: string) => GitHost,
  input: { id: string; host: string; account: string },
): Promise<{ saved: boolean; reason?: string }> {
  const org = await deps.org(input.id);
  if (org === undefined) throw new UserError(`Org "${input.id}" does not exist.`, 404);
  const host = input.host.toLowerCase();
  const row = org.accounts.find((a) => a.host === host && same(a.account, input.account));
  if (row === undefined) throw new UserError(`${input.id} has no ${input.account} account on ${host}.`, 404);
  let secret: string;
  try {
    secret = await deps.readSecret(host, row.account);
  } catch (err) {
    return {
      saved: false,
      reason: err instanceof Error ? err.message : "The Mac has no saved login for it.",
    };
  }
  const request = tokenRequest(host, classify(host), row.account, secret);
  const check = await checkToken(deps.probe, request);
  if (check.state !== "ok") {
    return {
      saved: false,
      reason: `${host} does not take the saved login for ${row.account} as a token. It is likely an account password. Make a token instead.`,
    };
  }
  const { ref } = await deps.saveSecret({
    value: request.value,
    label: `${input.id} ${request.kind} ${row.account} token`,
  });
  const git_accounts = org.accounts.map((a) => (a === row ? { ...a, token: ref } : a));
  await deps.write(input.id, { git_accounts, mr_token: { host: request.kind, ref } });
  return { saved: true };
}
