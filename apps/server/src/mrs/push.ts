import { FETCH_TIMEOUT_MS, GitError, git, gitOk } from "../git/git.ts";
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
  /**
   * Pushes `url` from the owner's Mac instead, where its saved https login lives. Set only for an
   * https route; the SSH retry below does not apply to it.
   */
  viaHost?: ((url: string, branch: string) => Promise<void>) | undefined;
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
  // Read before the push: if the branch moves meanwhile, the tracking branch lags, never leads.
  const tip = await git(req.worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${req.branch}`]).then(
    (s) => s.trim(),
    () => undefined,
  );
  const args = [
    "push",
    "--quiet",
    req.url ?? req.remote,
    `refs/heads/${req.branch}:refs/heads/${req.branch}`,
  ];
  if (req.viaHost !== undefined && req.url !== undefined) {
    try {
      await req.viaHost(req.url, req.branch);
    } catch (err) {
      throw new PushProblem(err instanceof Error ? err.message : String(err));
    }
    return await tracked(req, tip);
  }
  try {
    await git(req.worktree, args, { timeoutMs: PUSH_TIMEOUT_MS });
    return await tracked(req, tip);
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
  await tracked(req, tip);
}

/**
 * True when the remote's branch already is the local tip, so a push would change nothing. Read with
 * `ls-remote`, which writes nothing on the remote; the tracking branch is moved to the tip, as a push
 * would. False when it cannot tell (an https route through the Mac, a remote that does not answer):
 * the caller then pushes as before.
 */
export async function remoteHasTip(req: PushRequest): Promise<boolean> {
  if (req.viaHost !== undefined && req.url !== undefined) return false;
  const ref = `refs/heads/${req.branch}`;
  const tip = await git(req.worktree, ["rev-parse", "--verify", "--quiet", ref]).then(
    (s) => s.trim(),
    () => undefined,
  );
  if (tip === undefined) return false;
  const listed = await git(req.worktree, ["ls-remote", req.url ?? req.remote, ref], {
    timeoutMs: FETCH_TIMEOUT_MS,
  }).catch(() => "");
  const remote = listed
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, name]) => name === ref)?.[0];
  if (remote !== tip) return false;
  await git(req.worktree, ["update-ref", `refs/remotes/${req.remote}/${req.branch}`, tip]).catch(
    () => undefined,
  );
  return true;
}

/**
 * A push to the alias URL does not move the remote's tracking branch the way a push to the remote
 * does. Moves it, so "is this pushed" reads the truth until the next fetch.
 */
async function tracked(req: PushRequest, tip: string | undefined): Promise<void> {
  if (req.url === undefined || tip === undefined) return;
  await git(req.worktree, ["update-ref", `refs/remotes/${req.remote}/${req.branch}`, tip]).catch(
    () => undefined,
  );
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
