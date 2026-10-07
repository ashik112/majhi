import type { GitHost, Remote } from "@majhi/shared";
import type { SshConfig } from "./sshConfig.ts";

export interface RemoteAddress {
  /** True for scp-like `host:path` and `ssh://` URLs, where ~/.ssh/config applies. */
  ssh: boolean;
  /** Host name from the URL, without user or port. Undefined for local paths. */
  host?: string;
}

const SSH_SCHEMES = ["ssh", "git+ssh", "ssh+git"];

/** Finds the host in a git remote URL: `git@host:owner/repo`, `ssh://…`, `https://…`, and so on. */
export function parseRemoteUrl(url: string): RemoteAddress {
  const value = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme) {
    const authority = value.slice(scheme[0].length).split("/", 1)[0] ?? "";
    const host = stripPort(authority.slice(authority.lastIndexOf("@") + 1));
    const ssh = SSH_SCHEMES.includes((scheme[1] ?? "").toLowerCase());
    return host === "" ? { ssh } : { ssh, host };
  }
  // Git reads `[user@]host:path` as ssh when no slash comes before the first colon.
  const scp = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):/.exec(value);
  if (scp?.[1]) return { ssh: true, host: scp[1].replace(/^\[|\]$/g, "") };
  return { ssh: false };
}

/** GitHub, GitLab and Bitbucket, including self-hosted names like `gitlab.acme.dev`. */
export function classifyHost(host: string | undefined): GitHost {
  if (host === undefined) return "other";
  const labels = host.toLowerCase().split(/[.-]/);
  if (labels.includes("github")) return "github";
  if (labels.includes("gitlab")) return "gitlab";
  if (labels.includes("bitbucket")) return "bitbucket";
  return "other";
}

/** Classifies a remote, resolving the host through ~/.ssh/config when the URL uses an alias. */
export function describeRemote(name: string, url: string, ssh: SshConfig): Remote {
  const address = parseRemoteUrl(url);
  if (address.host === undefined) return { name, url, host: "other" };
  const real = address.ssh ? ssh.hostNameFor(address.host) : undefined;
  const hostName = (real ?? address.host).toLowerCase();
  return { name, url, host: classifyHost(hostName), hostName };
}

function stripPort(hostPort: string): string {
  if (hostPort.startsWith("[")) return hostPort.slice(1, hostPort.indexOf("]"));
  const colon = hostPort.indexOf(":");
  return colon === -1 ? hostPort : hostPort.slice(0, colon);
}
