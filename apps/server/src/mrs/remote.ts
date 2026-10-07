import type { MrHost, RemoteConfig } from "@majhi/shared";
import { classifyHost } from "../scan/remote.ts";
import type { SshConfig } from "../scan/sshConfig.ts";

/** The remote MRs go to: the one marked `mr: true`, else `origin`. */
export function mrRemoteName(remotes: Readonly<Record<string, RemoteConfig>> | undefined): string {
  for (const [name, remote] of Object.entries(remotes ?? {})) if (remote.mr === true) return name;
  return "origin";
}

interface Parts {
  user?: string;
  host: string;
  /** Without a leading slash. */
  path: string;
}

function split(url: string): Parts | undefined {
  const value = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]+)@)?([^/]*)(\/.*)?$/i.exec(value);
  if (scheme) {
    if ((scheme[1] ?? "").toLowerCase() === "file") return undefined;
    const host = (scheme[3] ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (host === "") return undefined;
    return { ...(scheme[2] ? { user: scheme[2] } : {}), host, path: (scheme[4] ?? "").replace(/^\/+/, "") };
  }
  const scp = /^(?:([^@/:]+)@)?([^/:@]+):(?!\/\/)(.*)$/.exec(value);
  if (scp?.[2])
    return { ...(scp[1] ? { user: scp[1] } : {}), host: scp[2], path: (scp[3] ?? "").replace(/^\/+/, "") };
  return undefined;
}

/**
 * The URL to push to when the workspace's git account for the host names an SSH alias (a `Host` in
 * ~/.ssh/config): the same
 * repository, reached as `git@<alias>:<path>`, so ssh picks the alias's key and host name. The port
 * of the original URL is dropped, because the alias owns it. A URL already on the alias, and a local
 * path, come back as they are.
 */
export function rewriteRemoteUrl(url: string, alias: string | undefined): string {
  if (alias === undefined || alias === "") return url;
  const parts = split(url);
  if (parts === undefined || parts.host === alias || parts.path === "") return url;
  return `${parts.user ?? "git"}@${alias}:${parts.path}`;
}

/**
 * `owner/repo` (or `group/subgroup/repo`) of a remote URL, without `.git`. A local path, as in
 * tests, gives its last two folders.
 */
export function repoSlug(url: string): string {
  const parts = split(url);
  const raw = parts?.path ?? url.trim().replace(/^file:\/\//, "");
  const segments = raw
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((s) => s !== "");
  return (parts === undefined ? segments.slice(-2) : segments).join("/");
}

/**
 * The real host name of a remote URL, lowercase: the URL's own, or the `HostName` an `~/.ssh/config`
 * alias reaches (`github.com` for `git@github-globex:acme/api.git`). Undefined for a local path.
 */
export function realHostOf(url: string, ssh: SshConfig): string | undefined {
  const name = hostNameOf(url)?.toLowerCase();
  if (name === undefined) return undefined;
  return ssh.hostNameFor(name)?.toLowerCase() ?? name;
}

/**
 * Which MR host a remote is, from its URL and the aliases of ~/.ssh/config. A host whose name says
 * nothing (a self-hosted `git.acme.example`) counts as GitLab when the workspace has a git account for
 * it (`hasAccount`), the way every git account of such a host is read. Undefined when nothing says.
 */
export function mrHostOf(url: string, ssh: SshConfig, hasAccount = false): MrHost | undefined {
  for (const name of [hostNameOf(url), realHostOf(url, ssh)]) {
    const host = classifyHost(name);
    if (host !== "other") return host;
  }
  return hasAccount ? "gitlab" : undefined;
}

/** The host name to reach a self-hosted GitLab or GitHub Enterprise: the URL's, unless it is an alias. */
export function hostNameOf(url: string): string | undefined {
  return split(url)?.host;
}
