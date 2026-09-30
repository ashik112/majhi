import { GitError, git, gitOk } from "../git/git.ts";
import { isSshAuthFailure } from "../git/worktrees.ts";

/** Pushing takes longer than the default git timeout. */
export const PUSH_TIMEOUT_MS = 120_000;

/** Something the owner can act on: no such remote, or the host refused the push. */
export class PushProblem extends Error {}

export interface PushRequest {
  /** The task's worktree; the branch is checked out there. */
  worktree: string;
  remote: string;
  branch: string;
  /**
   * Where to push instead of the remote: the same repo through the project's SSH alias. git pushes
   * straight to it, so a `pushurl` the remote already has cannot add a second destination. The git
   * config is not changed.
   */
  url?: string | undefined;
  /** Asks the host helper to load the owner's keys again; resolves true when it did. */
  reloadKeys?: (() => Promise<boolean>) | undefined;
}

/** The URL a remote fetches from. */
export async function remoteUrl(repo: string, remote: string): Promise<string> {
  try {
    return (await git(repo, ["remote", "get-url", remote])).trim();
  } catch {
    throw new PushProblem(
      `The repo has no remote named "${remote}". Add it, or name another in the project's remotes.`,
    );
  }
}

/**
 * `git push <remote> <branch>` from the worktree. The server's own ssh runs it, so the forwarded
 * SSH agent supplies the key; no key file is read or copied. Never forces. After an SSH access
 * failure the keys are reloaded once and the push is tried again.
 */
export async function pushBranch(req: PushRequest): Promise<void> {
  const args = [
    "push",
    "--quiet",
    req.url ?? req.remote,
    `refs/heads/${req.branch}:refs/heads/${req.branch}`,
  ];
  try {
    await git(req.worktree, args, { timeoutMs: PUSH_TIMEOUT_MS });
    return;
  } catch (err) {
    const first = asPush(err);
    if (!isSshAuthFailure(first.message) || req.reloadKeys === undefined) throw first;
    if (!(await req.reloadKeys().catch(() => false))) throw first;
  }
  try {
    await git(req.worktree, args, { timeoutMs: PUSH_TIMEOUT_MS });
  } catch (err) {
    throw asPush(err);
  }
}

function asPush(err: unknown): PushProblem {
  if (err instanceof GitError) {
    const denied = isSshAuthFailure(err.message);
    return new PushProblem(
      denied
        ? `The host did not accept an SSH key for the push (${err.message}). Reload your SSH keys, then try again.`
        : `git push failed: ${err.message}`,
    );
  }
  return new PushProblem(err instanceof Error ? err.message : String(err));
}

/** Commits on the branch that its base does not have. The base is the remote's copy when there is one. */
export async function commitsAhead(
  repo: string,
  base: string,
  remote: string,
  branch: string,
): Promise<number> {
  const baseRef = (await gitOk(repo, ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${base}`]))
    ? `${remote}/${base}`
    : base;
  const out = await git(repo, ["rev-list", "--count", `${baseRef}..refs/heads/${branch}`]);
  return Number(out.trim()) || 0;
}
