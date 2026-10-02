import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../errors.ts";
import { git, gitOk } from "../git/git.ts";
import { checkedOutAt } from "../git/merge.ts";

/**
 * Undo of a merge the captain made (SPEC 5.18): one revert commit on the target branch that takes
 * back what the merge changed, with any later work on the branch kept. The commit is made in a
 * throwaway worktree, then the branch moves forward to it: by a fast-forward in the owner's checkout
 * when the branch is checked out there (only when it holds no tracked changes), else by moving the
 * ref. Nothing is ever rewritten. When the revert conflicts with later work, nothing changes.
 */

export interface MergedRepo {
  project: string;
  /** The project's checkout. */
  source: string;
  into: string;
  /** The target's tip before the merge, and right after it. */
  before: string;
  after: string;
}

export interface Identity {
  name: string;
  email: string;
}

const sha = async (cwd: string, ref: string) => (await git(cwd, ["rev-parse", "--verify", ref])).trim();

function quiet(identity: Identity): string[] {
  return [
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "-c",
    "commit.gpgsign=false",
  ];
}

/** Takes the merge back with one revert commit on `into`. Returns the new tip, or undefined when the merge changed nothing. */
export async function revertMerge(
  repo: MergedRepo,
  identity: Identity,
  message: string,
): Promise<string | undefined> {
  const { source, into, before, after } = repo;
  const ref = `refs/heads/${into}`;
  if (!(await gitOk(source, ["rev-parse", "--verify", "--quiet", ref]))) {
    throw new UserError(
      `${repo.project} has no branch ${into} any more, so the merge cannot be undone.`,
      409,
    );
  }
  if (!(await gitOk(source, ["merge-base", "--is-ancestor", after, ref]))) {
    throw new UserError(
      `${into} in ${repo.project} no longer holds the merge, so there is nothing to undo.`,
      409,
    );
  }
  // What the merge changed, backwards: from its result to the target as it was.
  const patch = await git(source, ["diff", "--binary", "--full-index", after, before]);
  if (patch.trim() === "") return undefined;
  const at = (await checkedOutAt(source)).get(into);
  if (at !== undefined && (await git(at, ["status", "--porcelain", "--untracked-files=no"])).trim() !== "") {
    throw new UserError(
      `${at} has uncommitted changes on ${into}. Commit or stash them, then undo again.`,
      409,
    );
  }
  const tip = await sha(source, ref);
  const dir = await mkdtemp(join(tmpdir(), "majhi-undo-"));
  const scratch = join(dir, "tree");
  const file = join(dir, "revert.patch");
  await writeFile(file, patch);
  let head: string;
  try {
    await git(source, ["worktree", "add", "--quiet", "--detach", scratch, tip]);
    try {
      await git(scratch, ["apply", "--3way", "--index", "--whitespace=nowarn", file]);
    } catch {
      throw new UserError(
        `Later work on ${into} in ${repo.project} changed the same lines, so the merge cannot be undone on its own. Nothing changed.`,
        409,
      );
    }
    await git(scratch, [...quiet(identity), "commit", "--quiet", "--no-verify", "-m", message]);
    head = await sha(scratch, "HEAD");
  } finally {
    await git(source, ["worktree", "remove", "--force", scratch]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
  if (at !== undefined) await git(at, ["merge", "--ff-only", "--quiet", head]);
  else await git(source, ["update-ref", ref, head, tip]);
  return head;
}
