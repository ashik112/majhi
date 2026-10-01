import type { GitHostLogins, GitLogin } from "@majhi/shared";
import { hostNameOf, repoSlug } from "./remote.ts";

/** How majhi reaches a remote to push: the owner's pick, a key it found, or nothing it can use. */
export type PushRoute =
  | { state: "picked"; alias: string }
  | { state: "auto"; account: string; alias?: string }
  | { state: "ambiguous"; choices: GitLogin[] }
  | { state: "none" };

export interface RouteInput {
  /** The SSH alias the owner picked for the remote. It always wins. */
  explicit: string | undefined;
  /** The remote's namespace: `acme` of `acme/api`, or `group/sub` of `group/sub/api`. */
  owner: string;
  /** Logins of the remote's host. Only `ssh` ones can push. */
  logins: readonly GitLogin[];
}

/** The SSH route to push with. Prefers the account that owns the repo's namespace, else the only one. */
export function chooseRoute({ explicit, owner, logins }: RouteInput): PushRoute {
  if (explicit !== undefined && explicit !== "") return { state: "picked", alias: explicit };
  const ssh = logins.filter((l) => l.via === "ssh");
  if (ssh.length === 0) return { state: "none" };
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

/** The logins of one host, from a detection result. */
export function loginsOf(hosts: readonly GitHostLogins[], host: string): GitLogin[] {
  return hosts.find((h) => h.host === host.toLowerCase())?.logins ?? [];
}

/** The namespace of a remote: everything before the repo name. */
export function ownerOf(url: string): string {
  return repoSlug(url).split("/").slice(0, -1).join("/");
}

/** One plain line for the choices: `ashik-sample via github.com key`. */
export function describeLogin(host: string, login: GitLogin): string {
  return `${login.account} via ${login.alias ?? host} key`;
}
