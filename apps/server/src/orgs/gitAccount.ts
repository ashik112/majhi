import type { GitAccount, GitHostLogins } from "@majhi/shared";
import { UserError } from "../errors.ts";

export interface GitAccountDeps {
  org: (id: string) => Promise<{ identity?: { name: string; email: string } | undefined; accounts: GitAccount[] } | undefined>;
  /** The Mac's detected logins per host. Empty when the helper is not connected. */
  logins: () => Promise<readonly GitHostLogins[]>;
  /** Adopts the gh or glab token of the login into this org only, and returns its secret ref. */
  adopt: (via: "gh" | "glab", host: string) => Promise<string>;
  saveSecret: (input: { value: string; label: string }) => Promise<{ ref: string }>;
  /** Public name and email of the account on its host, when the host tells. */
  publicProfile: (host: string, account: string) => Promise<{ name: string; email: string } | undefined>;
  write: (id: string, patch: { git_accounts: GitAccount[]; identity?: { name: string; email: string } }) => Promise<void>;
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
    token = (await deps.saveSecret({ value: input.token, label: `${input.id} ${host} ${input.account} token` })).ref;
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
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
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
