import type { GitLoginsResult } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { HostLink } from "../host/link.ts";
import { hostNameOf } from "../mrs/remote.ts";
import { readGitMeta } from "../scan/gitMeta.ts";

const CACHE_MS = 60_000;
/** Each ssh probe waits up to nine seconds, in parallel. */
const CALL_TIMEOUT_MS = 30_000;

/** The accounts the owner's Mac is logged in as per git host, from the host helper. Holds no token. */
export class GitLoginService {
  private cached: { at: number; value: GitLoginsResult } | undefined;
  private running: Promise<GitLoginsResult> | undefined;

  constructor(
    private readonly link: Pick<HostLink, "call" | "isConnected"> | undefined,
    private readonly projectPaths: () => Promise<readonly string[]>,
    private readonly now: () => number = Date.now,
  ) {}

  async list(refresh = false): Promise<GitLoginsResult> {
    if (this.link === undefined || !this.link.isConnected()) {
      throw new UserError(
        "The host helper is not connected, so majhi cannot look at this Mac's git logins.",
        409,
      );
    }
    if (!refresh && this.cached !== undefined && this.now() - this.cached.at < CACHE_MS) {
      return this.cached.value;
    }
    const link = this.link;
    this.running ??= (async () => {
      try {
        const value = await link.call(
          "git.logins",
          { extraHosts: await this.remoteHosts() },
          CALL_TIMEOUT_MS,
        );
        this.cached = { at: this.now(), value };
        return value;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** Host names of every remote of every registered project, so self-hosted ones are probed too. */
  private async remoteHosts(): Promise<string[]> {
    const hosts = new Set<string>();
    for (const path of await this.projectPaths()) {
      const meta = await readGitMeta(path).catch(() => undefined);
      for (const remote of meta?.remotes ?? []) {
        const host = hostNameOf(remote.url);
        if (host !== undefined && host.includes(".")) hosts.add(host.toLowerCase());
      }
    }
    return [...hosts].sort().slice(0, 50);
  }
}
