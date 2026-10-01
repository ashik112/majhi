import { editorPath } from "../editor/allowed.ts";
import type { HostLink } from "../host/link.ts";

/** Pushing takes longer than most host jobs. */
const HOST_PUSH_TIMEOUT_MS = 130_000;

/** Pushes https remotes from the owner's Mac, where the Keychain login lives. */
export interface HostGit {
  connected(): boolean;
  /** Pushes `branch` of the repo at `path` to `url`. Throws a message safe to show. */
  push(input: { path: string; url: string; branch: string }): Promise<void>;
}

/**
 * The host helper's `git.push`. The path must be inside a workspace root, the tasks folder or a
 * registered project (the helper sees the same absolute paths as the container). Agents never call this.
 */
export function createHostGit(link: HostLink, allowed: () => Promise<readonly string[]>): HostGit {
  return {
    connected: () => link.status().connected,
    push: async ({ path, url, branch }) => {
      const safe = await editorPath(path, await allowed());
      await link.call("git.push", { path: safe, url, branch }, HOST_PUSH_TIMEOUT_MS);
    },
  };
}
