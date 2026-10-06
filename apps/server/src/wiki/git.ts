import { type CommitSha, CommitShaSchema, RepoPathSchema } from "@majhi/shared";
import { git } from "../git/git.ts";

/** The most changed files one comparison keeps. A change past this is a rewrite of the repo: every page is stale anyway. */
export const MAX_CHANGED = 5000;

/** The commit at the tip of a branch, or undefined when the branch is not there (no checkout, an unborn repo). */
export async function branchTip(repoPath: string, branch: string): Promise<CommitSha | undefined> {
  try {
    const out = (
      await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])
    ).trim();
    const sha = CommitShaSchema.safeParse(out);
    return sha.success ? sha.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The files that differ between two commits, as paths inside the repo. Undefined when git cannot say (the
 * commit is gone after a rewrite of history), which callers treat as "everything may have changed".
 */
export async function changedFiles(
  repoPath: string,
  from: string,
  to: string,
): Promise<string[] | undefined> {
  if (from === to) return [];
  try {
    const out = await git(repoPath, ["diff", "--name-only", "-z", `${from}..${to}`]);
    return out
      .split("\0")
      .filter((p) => RepoPathSchema.safeParse(p).success)
      .slice(0, MAX_CHANGED);
  } catch {
    return undefined;
  }
}
