import type { MrHost } from "@majhi/shared";
import { BitbucketHost, type BitbucketOptions } from "./bitbucket.ts";
import type { Exec } from "./exec.ts";
import { GitHubHost } from "./github.ts";
import { GitLabHost } from "./gitlab.ts";
import type { MrHostClient } from "./types.ts";

export type { MrHostClient, MrStatus, MrTarget, OpenMr } from "./types.ts";
export { MrHostError } from "./types.ts";

export interface MrHostOptions {
  exec?: Exec;
  /** Program names, for tests that put fake CLIs somewhere else than PATH. */
  bins?: { gh?: string; glab?: string };
  bitbucket?: BitbucketOptions;
}

/** The client for each MR host. */
export function createMrHosts(options: MrHostOptions = {}): Record<MrHost, MrHostClient> {
  return {
    github: new GitHubHost(options.exec, options.bins?.gh),
    gitlab: new GitLabHost(options.exec, options.bins?.glab),
    bitbucket: new BitbucketHost(options.bitbucket),
  };
}
