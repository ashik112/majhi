import type { TaskRepo } from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import { git, uncommitted } from "../git/git.ts";
import { removeWorktree } from "../git/worktrees.ts";

/**
 * "Delete the task branch and its worktree after" a merge or push. Checked twice: before the action
 * runs, so a worktree with uncommitted work refuses the whole action, and again right before the
 * delete. Only the local branch goes, never a remote one, and only a branch majhi created.
 */

/** Why the worktree cannot be deleted after shipping, or undefined. Untracked files count as work. */
export async function deleteRefusal(repo: TaskRepo): Promise<string | undefined> {
  if (repo.worktree === undefined) return undefined;
  const changes = await uncommitted(repo.worktree).catch(() => []);
  if (changes.length === 0) return undefined;
  const files = `${changes.length} ${changes.length === 1 ? "file" : "files"}`;
  return `${repo.project}'s worktree has uncommitted changes (${files}), so it cannot be deleted. Ask the agent to commit them, or ship without deleting.`;
}

export interface DeleteOutcome {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  detail: string;
}

/**
 * Removes the task's worktree and deletes its local branch, after a ship that succeeded. Both stay
 * when the worktree has uncommitted changes or the branch moved past `head`, the commit that was
 * shipped. The branch also stays when majhi did not create it, it is the base, or another task is
 * stacked on it.
 */
export async function deleteAfterShip(input: {
  repo: TaskRepo;
  /** The branch's commit when it was merged or pushed. */
  head: string;
  /** Another task's branch is stacked on this one. */
  stacked: boolean;
}): Promise<DeleteOutcome> {
  const { repo, head } = input;
  const { source, branch } = repo;
  const kept = (detail: string, worktreeRemoved = false): DeleteOutcome => ({
    worktreeRemoved,
    branchDeleted: false,
    detail,
  });

  const current = await git(source, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    (s) => s.trim(),
    () => undefined,
  );
  if (current !== undefined && current !== head) {
    return kept(`Kept ${branch} and its worktree: the branch has new commits since it was shipped.`);
  }
  if (repo.worktree !== undefined) {
    const refusal = await deleteRefusal(repo);
    if (refusal !== undefined) return kept(`Kept ${branch} and its worktree: ${refusal}`);
    try {
      await removeWorktree(source, repo.worktree, false);
    } catch (err) {
      return kept(`Kept ${branch} and its worktree: could not remove the worktree (${errorMessage(err)}).`);
    }
  }
  const removed = repo.worktree !== undefined;
  const without = removed ? "Removed the worktree. " : "";
  if (current === undefined) return kept(`${without}${branch} was already gone.`, removed);
  if (!repo.createdBranch) return kept(`${without}Kept ${branch}: majhi did not create it.`, removed);
  if (branch === repo.base) return kept(`${without}Kept ${branch}: it is the base branch.`, removed);
  if (input.stacked) return kept(`${without}Kept ${branch}: another task builds on it.`, removed);
  try {
    // `-D`: the ship that just succeeded is the proof; a squash leaves the branch unmerged to git.
    // git still refuses a branch checked out in another worktree.
    await git(source, ["branch", "-D", branch]);
  } catch (err) {
    return kept(`${without}Kept ${branch}: ${errorMessage(err)}.`, removed);
  }
  return {
    worktreeRemoved: removed,
    branchDeleted: true,
    detail: removed ? `Deleted ${branch} and its worktree.` : `Deleted ${branch}.`,
  };
}
