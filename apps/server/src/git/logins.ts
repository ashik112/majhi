import type { GitLoginsResult } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { HostLink } from "../host/link.ts";
import { hostNameOf } from "../mrs/remote.ts";
import { readGitMeta } from "../scan/gitMeta.ts";
import { type KeyOwner, resolveKeys } from "./keyOwners.ts";

const CACHE_MS = 60_000;
/** Each ssh probe waits up to nine seconds, in parallel. */
const CALL_TIMEOUT_MS = 30_000;

/** The accounts this computer is logged in as per git host, from the host helper. Holds no token. */
export class GitLoginService {
  private cached: { at: number; value: GitLoginsResult } | undefined;
  private running: Promise<GitLoginsResult> | undefined;
  private owners: ((host: string) => Promise<readonly KeyOwner[]>) | undefined;

  constructor(
    private readonly link: Pick<HostLink, "call" | "isConnected"> | undefined,
    private readonly projectPaths: () => Promise<readonly string[]>,
    private readonly now: () => number = Date.now,
  ) {}

  /** How accepted keys that name no account are matched to one: the key lists of the host's known accounts. */
  setKeyOwners(owners: (host: string) => Promise<readonly KeyOwner[]>): void {
    this.owners = owners;
  }

  /** When the logins were last detected, or undefined before the first answer. */
  checkedAt(): string | undefined {
    return this.cached === undefined ? undefined : new Date(this.cached.at).toISOString();
  }

  async list(refresh = false): Promise<GitLoginsResult> {
    if (this.link === undefined || !this.link.isConnected()) {
      throw new UserError(
        "The host helper is not connected, so majhi cannot look at this computer's git logins.",
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
        const hosts = await Promise.all(
          value.hosts.map(async (h) =>
            h.keys === undefined || this.owners === undefined
              ? h
              : await resolveKeys(h, await this.owners(h.host).catch(() => [])),
          ),
        );
        const resolved = { ...value, hosts };
        this.cached = { at: this.now(), value: resolved };
        return resolved;
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
