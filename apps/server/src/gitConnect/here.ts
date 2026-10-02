import type { RepoHere } from "@majhi/shared";
import { hostNameOf, repoSlug } from "../mrs/remote.ts";

/**
 * `host/owner/name` of a remote URL, for comparing remotes: host lowercased with its port dropped
 * and SSH aliases resolved to their real host, `.git` dropped, ssh and https alike. Undefined for a
 * local path.
 */
export function remoteKey(url: string, aliases: ReadonlyMap<string, string>): string | undefined {
  const host = hostNameOf(url)?.toLowerCase();
  if (host === undefined) return undefined;
  const real = (aliases.get(host) ?? host).toLowerCase().replace(/:\d+$/, "");
  const path = repoSlug(url).toLowerCase();
  return path === "" ? undefined : `${real}/${path}`;
}

/** The key of a repo on a host: the same shape as `remoteKey`. */
export function repoKeyOf(host: string, fullName: string): string {
  return `${host.toLowerCase().replace(/:\d+$/, "")}/${fullName.toLowerCase().replace(/\.git$/, "")}`;
}

export interface HereIndex {
  projects: readonly { id: string; org: string; path: string; remotes: readonly string[] }[];
  /** Repos found under the roots, registered or not. */
  scanned: readonly { path: string; remotes: readonly string[] }[];
  aliases: ReadonlyMap<string, string>;
}

/** Where a remote repo already is: a project that has it as a remote, else a repo under a root, else nothing. */
export function hereOf(index: HereIndex, key: string, cloneFolder: string | undefined): RepoHere {
  for (const p of index.projects) {
    if (p.remotes.some((url) => remoteKey(url, index.aliases) === key)) {
      return { state: "registered", project: p.id, org: p.org, path: p.path };
    }
  }
  for (const r of index.scanned) {
    if (r.remotes.some((url) => remoteKey(url, index.aliases) === key))
      return { state: "cloned", path: r.path };
  }
  return cloneFolder === undefined ? { state: "none" } : { state: "cloned", path: cloneFolder };
}
