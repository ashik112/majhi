import { rm } from "node:fs/promises";
import { GitError, git, gitOk } from "./git.ts";

/**
 * Local merges of a task branch into any branch (main, dev, staging, ...), done by the server,
 * which sees the owner's checkout. Never pushes. Git runs with hooks and signing off, so the
 * owner's setup cannot block or prompt.
 */

export interface MergeIdentity {
  name: string;
  email: string;
}

export interface MergeRequest {
  /** The project's checkout: any worktree of the repo works for ref lookups. */
  source: string;
  /** The task branch. */
  branch: string;
  /** The branch to merge into. */
  into: string;
  identity: MergeIdentity;
  message: string;
  /** A folder majhi may use for a temporary worktree when `into` is checked out nowhere. */
  scratch: string;
}

export type MergeOutcome =
  | { ok: true; how: "fast-forward" | "merge commit" | "already merged"; where: string }
  | { ok: false; reason: string };

function quiet(identity: MergeIdentity): string[] {
  return [
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
  ];
}

/** Where each local branch is checked out, from `git worktree list --porcelain`. */
export async function checkedOutAt(source: string): Promise<Map<string, string>> {
  const out = await git(source, ["worktree", "list", "--porcelain"]);
  const map = new Map<string, string>();
  let path: string | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && path !== undefined) {
      map.set(line.slice("branch refs/heads/".length), path);
    }
  }
  return map;
}

/** Local branch names, the current one first. */
export async function localBranches(source: string): Promise<string[]> {
  const out = await git(source, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return out.split("\n").filter((b) => b !== "");
}

export async function mergeBranch(req: MergeRequest): Promise<MergeOutcome> {
  const { source, branch, into } = req;
  if (!(await gitOk(source, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]))) {
    return { ok: false, reason: `The branch ${branch} does not exist.` };
  }
  if (!(await gitOk(source, ["rev-parse", "--verify", "--quiet", `refs/heads/${into}`]))) {
    return { ok: false, reason: `There is no local branch ${into} to merge into.` };
  }
  if (await gitOk(source, ["merge-base", "--is-ancestor", branch, into])) {
    return { ok: true, how: "already merged", where: into };
  }
  const fastForward = await gitOk(source, ["merge-base", "--is-ancestor", into, branch]);
  const at = (await checkedOutAt(source)).get(into);

  if (at !== undefined) return mergeIn(at, req, fastForward);

  // Checked out nowhere: move the ref for a fast-forward, else merge in a throwaway worktree.
  if (fastForward) {
    const to = (await git(source, ["rev-parse", branch])).trim();
    const from = (await git(source, ["rev-parse", into])).trim();
    await git(source, ["update-ref", `refs/heads/${into}`, to, from]);
    return { ok: true, how: "fast-forward", where: into };
  }
  await rm(req.scratch, { recursive: true, force: true });
  await git(source, ["worktree", "add", req.scratch, into]);
  try {
    const outcome = await mergeIn(req.scratch, req, false);
    return outcome.ok ? { ...outcome, where: into } : outcome;
  } finally {
    await git(source, ["worktree", "remove", "--force", req.scratch]).catch(() => undefined);
  }
}

/** Merges in a checkout that has `into` checked out. Refuses tracked changes; aborts on conflict. */
async function mergeIn(checkout: string, req: MergeRequest, fastForward: boolean): Promise<MergeOutcome> {
  const changed = (await git(checkout, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (changed !== "") {
    return {
      ok: false,
      reason: `${checkout} has uncommitted changes on ${req.into}. Commit or stash them, then merge again.`,
    };
  }
  if (fastForward) {
    await git(checkout, ["merge", "--ff-only", req.branch]);
    return { ok: true, how: "fast-forward", where: checkout };
  }
  try {
    await git(checkout, [
      ...quiet(req.identity),
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      req.message,
      req.branch,
    ]);
    return { ok: true, how: "merge commit", where: checkout };
  } catch (err) {
    const conflicts = (await git(checkout, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
      .split("\n")
      .filter((f) => f !== "");
    await git(checkout, ["merge", "--abort"]).catch(() => undefined);
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: `Conflicts in ${conflicts.slice(0, 8).join(", ")}${conflicts.length > 8 ? " and more" : ""}. Nothing was merged. Ask the agent to merge ${req.into} into its branch and resolve them.`,
      };
    }
    return { ok: false, reason: err instanceof GitError ? err.message : String(err) };
  }
}
