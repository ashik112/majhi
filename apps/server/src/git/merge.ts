import { rm } from "node:fs/promises";
import { GitError, git, gitOk } from "./git.ts";

/**
 * Local merges of a task branch into any branch (main, dev, staging, ...), done by the server,
 * which sees the owner's checkout. Never pushes. Git runs with signing off, and `git` keeps hooks,
 * filters and merge drivers off, so the owner's setup cannot block or prompt. The target branch only ever moves forward: a merge or
 * squash adds a commit on it, a rebase rewrites the task branch and then fast-forwards the target.
 * Any conflict is aborted, so both branches stay exactly as they were.
 */

export interface MergeIdentity {
  name: string;
  email: string;
}

/** How the task branch lands on the target: a merge commit, one squashed commit, or rebased and fast-forwarded. */
export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergeRequest {
  /** The project's checkout: any worktree of the repo works for ref lookups. */
  source: string;
  /** The task branch. */
  branch: string;
  /** The branch to merge into. */
  into: string;
  identity: MergeIdentity;
  /** The merge or squash commit's message. */
  message: string;
  /** A folder majhi may use for a temporary worktree when a branch is checked out nowhere. */
  scratch: string;
  /** Default `merge`. */
  method?: MergeMethod | undefined;
}

export type MergeOutcome =
  | {
      ok: true;
      how: "fast-forward" | "merge commit" | "squash commit" | "rebased" | "already merged";
      where: string;
      /** The task branch's commit afterwards: a rebase moves it. */
      head: string;
    }
  | { ok: false; reason: string; conflicts?: string[] };

function quiet(identity: MergeIdentity): string[] {
  return [
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "-c",
    "commit.gpgsign=false",
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

/** Branches of a remote as this machine last fetched them, without the remote's name or HEAD. */
export async function remoteBranches(source: string, remote: string): Promise<string[]> {
  const out = await git(source, ["for-each-ref", "--format=%(refname)", `refs/remotes/${remote}/`]);
  const prefix = `refs/remotes/${remote}/`;
  return out
    .split("\n")
    .filter((r) => r.startsWith(prefix))
    .map((r) => r.slice(prefix.length))
    .filter((b) => b !== "" && b !== "HEAD");
}

const sha = async (cwd: string, ref: string) => (await git(cwd, ["rev-parse", ref])).trim();

export async function mergeBranch(req: MergeRequest): Promise<MergeOutcome> {
  const { source, branch, into } = req;
  if (!(await gitOk(source, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]))) {
    return { ok: false, reason: `The branch ${branch} does not exist.` };
  }
  if (!(await gitOk(source, ["rev-parse", "--verify", "--quiet", `refs/heads/${into}`]))) {
    return { ok: false, reason: `There is no local branch ${into} to merge into.` };
  }
  if (await gitOk(source, ["merge-base", "--is-ancestor", branch, into])) {
    return { ok: true, how: "already merged", where: into, head: await sha(source, branch) };
  }
  const method = req.method ?? "merge";
  if (method === "rebase") return rebaseAndForward(req);
  const fastForward =
    method === "merge" && (await gitOk(source, ["merge-base", "--is-ancestor", into, branch]));
  const at = (await checkedOutAt(source)).get(into);

  if (at !== undefined) return integrateIn(at, req, fastForward);

  // Checked out nowhere: move the ref for a fast-forward, else merge in a throwaway worktree.
  if (fastForward) {
    const to = await sha(source, branch);
    const from = await sha(source, into);
    await git(source, ["update-ref", `refs/heads/${into}`, to, from]);
    return { ok: true, how: "fast-forward", where: into, head: to };
  }
  await rm(req.scratch, { recursive: true, force: true });
  await git(source, ["worktree", "add", req.scratch, into]);
  try {
    const outcome = await integrateIn(req.scratch, req, false);
    return outcome.ok ? { ...outcome, where: into } : outcome;
  } finally {
    await git(source, ["worktree", "remove", "--force", req.scratch]).catch(() => undefined);
  }
}

/**
 * The files that would conflict if `branch` merged into `into` now, from `git merge-tree`, which
 * touches no checkout and no ref. Empty when it merges cleanly.
 */
export async function mergeConflicts(source: string, branch: string, into: string): Promise<string[]> {
  try {
    await git(source, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      `refs/heads/${into}`,
      `refs/heads/${branch}`,
    ]);
    return [];
  } catch (err) {
    // Exit 1 is "conflicts": the tree id, then one conflicted file per line. Anything else failed.
    if (!(err instanceof GitError) || err.exitCode !== 1) throw err;
    const files = err.stdout
      .split("\n")
      .slice(1)
      .map((f) => f.trim())
      .filter((f) => f !== "");
    return [...new Set(files)];
  }
}

/**
 * Why `branch` cannot merge into `into` now, or undefined when it can. Reads only: no checkout, no
 * ref moves. Checks the branches exist, the checkout that has `into` holds no tracked changes, and
 * `git merge-tree` finds no conflict. A rebase can still stop on a commit the merge-tree check
 * passes; that case is reported when it happens.
 */
export async function mergeBlocker(
  source: string,
  branch: string,
  into: string,
): Promise<{ reason: string; conflicts?: string[] } | undefined> {
  if (!(await gitOk(source, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]))) {
    return { reason: `The branch ${branch} does not exist.` };
  }
  if (!(await gitOk(source, ["rev-parse", "--verify", "--quiet", `refs/heads/${into}`]))) {
    return { reason: `There is no local branch ${into} to merge into.` };
  }
  if (await gitOk(source, ["merge-base", "--is-ancestor", branch, into])) return undefined;
  const at = (await checkedOutAt(source)).get(into);
  if (at !== undefined && (await trackedChanges(at))) {
    return { reason: `${at} has uncommitted changes on ${into}. Commit or stash them, then merge again.` };
  }
  const conflicts = await mergeConflicts(source, branch, into);
  if (conflicts.length > 0) return { reason: `Conflicts with ${into} in ${listed(conflicts)}.`, conflicts };
  return undefined;
}

/** Files git left unmerged in a checkout, after a merge, squash or rebase stopped. */
async function unmerged(checkout: string): Promise<string[]> {
  return (await git(checkout, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f !== "");
}

function listed(files: readonly string[]): string {
  return `${files.slice(0, 8).join(", ")}${files.length > 8 ? " and more" : ""}`;
}

async function trackedChanges(checkout: string): Promise<boolean> {
  return (await git(checkout, ["status", "--porcelain", "--untracked-files=no"])).trim() !== "";
}

/**
 * Merges or squashes in a checkout that has `into` checked out. Refuses tracked changes; on a
 * conflict or any failure, resets to where it started.
 */
async function integrateIn(checkout: string, req: MergeRequest, fastForward: boolean): Promise<MergeOutcome> {
  if (await trackedChanges(checkout)) {
    return {
      ok: false,
      reason: `${checkout} has uncommitted changes on ${req.into}. Commit or stash them, then merge again.`,
    };
  }
  const head = await sha(checkout, `refs/heads/${req.branch}`);
  if (fastForward) {
    await git(checkout, ["merge", "--ff-only", req.branch]);
    return { ok: true, how: "fast-forward", where: checkout, head };
  }
  if (req.method === "squash") return squashIn(checkout, req, head);
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
    return { ok: true, how: "merge commit", where: checkout, head };
  } catch (err) {
    const conflicts = await unmerged(checkout);
    await git(checkout, ["merge", "--abort"]).catch(() => undefined);
    return failed(err, conflicts);
  }
}

/** One commit on `into` with everything the task branch changed. The task branch is not touched. */
async function squashIn(checkout: string, req: MergeRequest, head: string): Promise<MergeOutcome> {
  const start = await sha(checkout, "HEAD");
  try {
    await git(checkout, [...quiet(req.identity), "merge", "--squash", "--quiet", req.branch]);
    // The target already has every change: nothing to commit, nothing to undo.
    if (await gitOk(checkout, ["diff", "--cached", "--quiet"])) {
      return { ok: true, how: "already merged", where: checkout, head };
    }
    await git(checkout, [...quiet(req.identity), "commit", "--quiet", "--no-edit", "-m", req.message]);
    return { ok: true, how: "squash commit", where: checkout, head };
  } catch (err) {
    const conflicts = await unmerged(checkout);
    // A squash leaves no MERGE_HEAD, so `merge --abort` cannot undo it; `reset --merge` is what it runs.
    await git(checkout, ["reset", "--quiet", "--merge", start]).catch(() => undefined);
    return failed(err, conflicts);
  }
}

function failed(err: unknown, conflicts: string[]): MergeOutcome {
  if (conflicts.length > 0) {
    return { ok: false, reason: `Nothing was merged. Conflicts in ${listed(conflicts)}.`, conflicts };
  }
  return { ok: false, reason: err instanceof GitError ? err.message : String(err) };
}

/**
 * Rebases the task branch onto `into`, then fast-forwards `into` to it. `into` is never rewritten:
 * it moves only by a fast-forward from the commit read at the start. A conflict aborts the rebase,
 * and a fast-forward that cannot happen puts the task branch back, so both stay as they were.
 */
async function rebaseAndForward(req: MergeRequest): Promise<MergeOutcome> {
  const { source, branch, into } = req;
  const places = await checkedOutAt(source);
  const intoAt = places.get(into);
  if (intoAt !== undefined && (await trackedChanges(intoAt))) {
    return {
      ok: false,
      reason: `${intoAt} has uncommitted changes on ${into}. Commit or stash them, then merge again.`,
    };
  }
  const target = await sha(source, into);
  const original = await sha(source, branch);
  let branchAt = places.get(branch);
  const scratch = branchAt === undefined;
  if (branchAt === undefined) {
    await rm(req.scratch, { recursive: true, force: true });
    await git(source, ["worktree", "add", req.scratch, branch]);
    branchAt = req.scratch;
  }
  try {
    if (await trackedChanges(branchAt)) {
      return {
        ok: false,
        reason: `${branchAt} has uncommitted changes on ${branch}. Commit them, then merge again.`,
      };
    }
    if (!(await gitOk(source, ["merge-base", "--is-ancestor", target, branch]))) {
      try {
        await git(branchAt, [
          ...quiet(req.identity),
          "-c",
          "rebase.autoStash=false",
          "-c",
          "rebase.updateRefs=false",
          "-c",
          "rebase.autoSquash=false",
          "rebase",
          "--quiet",
          target,
        ]);
      } catch (err) {
        const conflicts = await unmerged(branchAt);
        await git(branchAt, ["rebase", "--abort"]).catch(() => undefined);
        await putBack(branchAt, branch, original);
        if (conflicts.length > 0) {
          return {
            ok: false,
            reason: `Nothing was merged. Rebasing ${branch} onto ${into} hit conflicts in ${listed(conflicts)}.`,
            conflicts,
          };
        }
        return failed(err, []);
      }
    }
    const head = await sha(source, branch);
    try {
      if (intoAt !== undefined) await git(intoAt, ["merge", "--quiet", "--ff-only", head]);
      else await git(source, ["update-ref", `refs/heads/${into}`, head, target]);
    } catch (err) {
      await putBack(branchAt, branch, original);
      return { ok: false, reason: `Could not move ${into} forward (${errorText(err)}). Nothing was merged.` };
    }
    return { ok: true, how: "rebased", where: intoAt ?? into, head };
  } finally {
    if (scratch) await git(source, ["worktree", "remove", "--force", req.scratch]).catch(() => undefined);
  }
}

/** Sets the task branch back to `original` in the checkout that has it, when it moved. */
async function putBack(checkout: string, branch: string, original: string): Promise<void> {
  if ((await sha(checkout, `refs/heads/${branch}`)) === original) return;
  await git(checkout, ["reset", "--quiet", "--hard", original]);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
