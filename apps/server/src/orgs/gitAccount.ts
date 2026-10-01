import type { GitAccount, GitHostLogins } from "@majhi/shared";
import { UserError } from "../errors.ts";

export interface GitAccountDeps {
  org: (
    id: string,
  ) => Promise<
    { identity?: { name: string; email: string } | undefined; accounts: GitAccount[] } | undefined
  >;
  /** The Mac's detected logins per host. Empty when the helper is not connected. */
  logins: () => Promise<readonly GitHostLogins[]>;
  /** Adopts the gh or glab token of the login into this org only, and returns its secret ref. */
  adopt: (via: "gh" | "glab", host: string) => Promise<string>;
  saveSecret: (input: { value: string; label: string }) => Promise<{ ref: string }>;
  /** Public name and email of the account on its host, when the host tells. */
  publicProfile: (host: string, account: string) => Promise<{ name: string; email: string } | undefined>;
  write: (
    id: string,
    patch: { git_accounts: GitAccount[]; identity?: { name: string; email: string } },
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

/** Binds one git account to one org. Only this org's config and secrets change. */
export async function setGitAccount(
  deps: GitAccountDeps,
  input: { id: string; host: string; account: string; ssh?: string | undefined; token?: string | undefined },
): Promise<void> {
  const org = await deps.org(input.id);
  if (org === undefined) throw new UserError(`Org "${input.id}" does not exist.`, 404);
  const host = input.host.toLowerCase();
  const previous = org.accounts.find((a) => a.host === host && same(a.account, input.account));
  let token = previous?.token;
  if (input.token !== undefined) {
    token = (
      await deps.saveSecret({ value: input.token, label: `${input.id} ${host} ${input.account} token` })
    ).ref;
  } else if (token === undefined) {
    const login = (await deps.logins().catch(() => []))
      .find((h) => h.host === host)
      ?.logins.find((l) => l.via !== "ssh" && same(l.account, input.account));
    if (login !== undefined && login.via !== "ssh") token = await deps.adopt(login.via, host);
  }
  const entry: GitAccount = {
    host,
    account: input.account,
    ...(input.ssh === undefined ? {} : { ssh: input.ssh }),
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
  await deps.write(input.id, { git_accounts, ...(fill === undefined ? {} : { identity: fill }) });
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
  /** One cheap authenticated call to the host's API. Returns the HTTP status. */
  probe: (url: string, headers: Record<string, string>) => Promise<number>;
  saveSecret: GitAccountDeps["saveSecret"];
  /** Writes this org's account list and `mr_tokens` entry. */
  write: (
    id: string,
    patch: { git_accounts: GitAccount[]; mr_token: { host: "github" | "gitlab" | "bitbucket"; ref: string } },
  ) => Promise<void>;
}

/** The API call that proves a secret is a working token for the host, with how to send it. */
export function tokenCheck(
  host: string,
  kind: "github" | "gitlab" | "bitbucket" | "other",
  account: string,
  secret: string,
): { kind: "github" | "gitlab" | "bitbucket"; url: string; headers: Record<string, string>; value: string } {
  if (kind === "github") {
    return {
      kind,
      url: "https://api.github.com/user",
      headers: { authorization: `Bearer ${secret}`, accept: "application/vnd.github+json" },
      value: secret,
    };
  }
  if (kind === "bitbucket") {
    const value = `${account}:${secret}`;
    return {
      kind,
      url: "https://api.bitbucket.org/2.0/user",
      headers: { authorization: `Basic ${Buffer.from(value).toString("base64")}` },
      value,
    };
  }
  return {
    kind: "gitlab",
    url: `https://${host}/api/v4/user`,
    headers: { authorization: `Bearer ${secret}` },
    value: secret,
  };
}

/**
 * Adopts the Mac's saved https login (Keychain or `gh`) as the account's token, only for the chosen
 * org and only when the host's API accepts it. An account password or a stale login is refused with
 * a plain sentence. The secret is never returned or logged.
 */
export async function useSavedLogin(
  deps: SavedLoginDeps,
  classify: (host: string) => "github" | "gitlab" | "bitbucket" | "other",
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
  const check = tokenCheck(host, classify(host), row.account, secret);
  const status = await deps.probe(check.url, check.headers).catch(() => 0);
  if (status < 200 || status >= 300) {
    return {
      saved: false,
      reason: `The saved login for ${row.account} on ${host} is not a token ${host} accepts, likely an account password. Paste a token instead.`,
    };
  }
  const { ref } = await deps.saveSecret({
    value: check.value,
    label: `${input.id} ${check.kind} ${row.account} token`,
  });
  const git_accounts = org.accounts.map((a) => (a === row ? { ...a, token: ref } : a));
  await deps.write(input.id, { git_accounts, mr_token: { host: check.kind, ref } });
  return { saved: true };
}
