import { type GitHostLogins, type GitLogin, normalizeSshRoute, sshRouteMatches } from "@majhi/shared";
import { hostNameOf, repoSlug } from "./remote.ts";

/** How majhi reaches a remote to push: a key it found for the workspace's account, or nothing it can use. */
export type PushRoute =
  | { state: "auto"; account: string; alias?: string }
  | { state: "ambiguous"; choices: GitLogin[] }
  /** No SSH key fits and the host helper is connected: push over https with the computer's saved login. */
  | { state: "https"; account?: string }
  /** The project's org binds an account, and no detected SSH key logs in as it. */
  | { state: "org-missing"; account: string }
  | { state: "none" };

export interface RouteInput {
  /** The remote's host name, so an org route saved as the host name reads as its default key. */
  host?: string | undefined;
  /** The git account the project's org bound for this host. Wins over the automatic choice. */
  org?: { account: string; ssh?: string | undefined } | undefined;
  /** The remote's namespace: `acme` of `acme/api`, or `group/sub` of `group/sub/api`. */
  owner: string;
  /** Logins of the remote's host. Only `ssh` ones can push. */
  logins: readonly GitLogin[];
  /** True while the host helper is connected, so an https push from the computer can work. */
  httpsOk?: boolean | undefined;
}

/** The SSH route to push with. The workspace's git account for the host decides; without one it prefers the account that owns the repo's namespace, else the only one. */
export function chooseRoute({ host, org, owner, logins, httpsOk }: RouteInput): PushRoute {
  const ssh = logins.filter((l) => l.via === "ssh");
  if (org !== undefined) {
    const route = normalizeSshRoute(host ?? "", org.ssh);
    const mine = ssh.filter(
      (l) => l.account.toLowerCase() === org.account.toLowerCase() && sshRouteMatches(route, l),
    );
    const first = mine.find((l) => l.alias === undefined) ?? mine[0];
    if (first === undefined) {
      return httpsOk === true
        ? { state: "https", account: org.account }
        : { state: "org-missing", account: org.account };
    }
    return {
      state: "auto",
      account: first.account,
      ...(first.alias === undefined ? {} : { alias: first.alias }),
    };
  }
  if (ssh.length === 0) return httpsOk === true ? { state: "https" } : { state: "none" };
  const pick = (candidates: readonly GitLogin[]): PushRoute | undefined => {
    const accounts = new Set(candidates.map((c) => c.account.toLowerCase()));
    if (accounts.size !== 1) return undefined;
    // The same account by several routes: the host name itself first, then the first alias.
    const first = candidates.find((c) => c.alias === undefined) ?? candidates[0];
    if (first === undefined) return undefined;
    return {
      state: "auto",
      account: first.account,
      ...(first.alias === undefined ? {} : { alias: first.alias }),
    };
  };
  const owned = ssh.filter((l) => l.account.toLowerCase() === owner.split("/")[0]?.toLowerCase());
  return (owned.length > 0 ? pick(owned) : undefined) ?? pick(ssh) ?? { state: "ambiguous", choices: ssh };
}

/**
 * The SSH address of an https remote: `git@<host>:<path>`, or `git@<alias>:<path>`. The repo's own
 * remote is not changed. Anything that is not https comes back as it is.
 */
export function httpsToSsh(url: string, alias?: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  const host = hostNameOf(url);
  const path = repoSlug(url);
  if (host === undefined || path === "") return url;
  return `git@${alias ?? host}:${path}.git`;
}

/**
 * The https address to push from the computer: any password in the remote is dropped, and the org's
 * account becomes the user, so the git credential helper hands over that account's login. Non-https
 * comes back as is.
 */
export function httpsPushUrl(url: string, account?: string): string {
  if (!/^https:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    u.password = "";
    if (account !== undefined) u.username = account;
    return u.toString();
  } catch {
    return url;
  }
}

/** The logins of one host, from a detection result. */
export function loginsOf(hosts: readonly GitHostLogins[], host: string): GitLogin[] {
  return hosts.find((h) => h.host === host.toLowerCase())?.logins ?? [];
}

/** The namespace of a remote: everything before the repo name. */
export function ownerOf(url: string): string {
  return repoSlug(url).split("/").slice(0, -1).join("/");
}

/** One plain line for the choices: `acme-dev via github.com key`. */
export function describeLogin(host: string, login: GitLogin): string {
  return `${login.account} via ${login.alias ?? host} key`;
}
