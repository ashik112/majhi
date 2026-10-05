import type { TaskRepo, UnshippedRepo } from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import { git, gitOk, localBranchExists } from "../git/git.ts";

/** Past this many changed files the squash check is skipped: the branch counts by its commits. */
const MAX_SQUASH_FILES = 500;

/**
 * Commits on a task branch that are nowhere else. Zero when the work is shipped:
 * - its merge request is open or merged;
 * - majhi merged the branch itself and it is still at the tip it merged (any method);
 * - the branch is gone, or has nothing past its base;
 * - another branch has its tip (merged into the base or any local branch that is not a task's),
 *   or a remote-tracking ref has it (pushed, as of the last fetch);
 * - it was pushed (`pushedAt`) and nothing was committed after the push;
 * - every commit has a patch-equivalent one in the base (`git cherry`: rebased or cherry-picked);
 * - every file it changed reads the same in the base (squash-merged).
 * Read in the project's own checkout; nothing is written.
 */
export async function unshippedCommits(
  repo: TaskRepo,
  taskBranches: ReadonlySet<string> = new Set(),
): Promise<number> {
  if (repo.mr?.state === "open" || repo.mr?.state === "merged") return 0;
  const cwd = repo.source;
  await git(cwd, ["rev-parse", "--git-dir"]);
  if (!(await localBranchExists(cwd, repo.branch))) return 0;
  const own = `refs/heads/${repo.branch}`;
  const tip = (await git(cwd, ["rev-parse", own])).trim();
  if (repo.shipped?.head === tip) return 0;

  const holders = (
    await git(cwd, ["for-each-ref", "--contains", tip, "--format=%(refname)", "refs/heads", "refs/remotes"])
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((ref) => ref !== "" && ref !== own);
  const base = `refs/heads/${repo.base}`;
  // Another task's branch stacked on this one does not ship it.
  const isTask = (ref: string) =>
    ref.startsWith("refs/heads/task/") || taskBranches.has(ref.slice("refs/heads/".length));
  if (holders.some((ref) => ref === base || !isTask(ref))) return 0;

  if (repo.pushedAt !== undefined) {
    // Whole seconds: a commit in the same second as the push counts as after it.
    const committed = Number((await git(cwd, ["log", "-1", "--format=%ct", tip])).trim());
    if (committed < Math.floor(Date.parse(repo.pushedAt) / 1000)) return 0;
  }

  const upstreams = await baseRefs(cwd, repo.base);
  if (upstreams.length === 0) {
    // No base to compare with: every commit no other ref has.
    const out = await git(cwd, [
      "rev-list",
      "--count",
      tip,
      "--not",
      `--exclude=${own}`,
      "--branches",
      "--remotes",
    ]);
    return Number(out.trim()) || 0;
  }
  return aheadOf(cwd, upstreams, tip);
}

/**
 * Commits of `tip` that `base` (the local branch or a remote's copy) does not have: by ancestry, a
 * patch-equivalent commit (`git cherry`: rebased or cherry-picked) or a squash. Zero when it is in;
 * undefined when the repo has no such base.
 */
export async function aheadOfBase(cwd: string, base: string, tip: string): Promise<number | undefined> {
  const upstreams = await baseRefs(cwd, base);
  return upstreams.length === 0 ? undefined : aheadOf(cwd, upstreams, tip);
}

async function aheadOf(cwd: string, upstreams: readonly string[], tip: string): Promise<number> {
  let fewest = Number.POSITIVE_INFINITY;
  for (const upstream of upstreams) {
    const cherry = await git(cwd, ["cherry", upstream, tip]);
    const left = cherry.split("\n").filter((l) => l.startsWith("+")).length;
    if (left === 0 || (await squashed(cwd, upstream, tip))) return 0;
    fewest = Math.min(fewest, left);
  }
  return fewest;
}

/** The base as a local branch and as each remote's copy, those that exist. */
async function baseRefs(cwd: string, base: string): Promise<string[]> {
  const remotes = (await git(cwd, ["remote"])).split("\n").filter((r) => r.trim() !== "");
  const refs = [`refs/heads/${base}`, ...remotes.map((r) => `refs/remotes/${r.trim()}/${base}`)];
  const found: string[] = [];
  for (const ref of refs) if (await gitOk(cwd, ["show-ref", "--verify", "--quiet", ref])) found.push(ref);
  return found;
}

/** Every file the branch changed since it left `upstream` reads the same there now. */
async function squashed(cwd: string, upstream: string, tip: string): Promise<boolean> {
  const from = (await git(cwd, ["merge-base", upstream, tip]).catch(() => "")).trim();
  if (from === "") return false;
  const files = (await git(cwd, ["diff", "--name-only", "-z", "--no-renames", from, tip]))
    .split("\0")
    .filter((f) => f !== "");
  if (files.length === 0 || files.length > MAX_SQUASH_FILES) return false;
  return gitOk(cwd, ["--literal-pathspecs", "diff", "--quiet", upstream, tip, "--", ...files]);
}

/** The repos of a task whose work is not shipped. A repo git cannot read counts as not shipped. */
export async function unshippedWork(
  repos: readonly TaskRepo[],
  /** The branches of every task in a repo (by its path), so a task's branch stacked on this one does not ship it. */
  taskBranchesIn: (source: string) => ReadonlySet<string> = () => new Set(),
): Promise<UnshippedRepo[]> {
  const out: UnshippedRepo[] = [];
  for (const repo of repos) {
    try {
      const commits = await unshippedCommits(repo, taskBranchesIn(repo.source));
      if (commits > 0) out.push({ project: repo.project, branch: repo.branch, commits });
    } catch (err) {
      out.push({ project: repo.project, branch: repo.branch, commits: 0, problem: errorMessage(err) });
    }
  }
  return out;
}

/** "acme-api: 1 commit on feat/acm-1-fix is not merged, pushed or in a pull request." One sentence per repo. */
export function unshippedText(list: readonly UnshippedRepo[]): string {
  return list
    .map((r) =>
      r.problem !== undefined
        ? `${r.project}: could not check whether ${r.branch} is shipped (${r.problem}).`
        : `${r.project}: ${r.commits} commit${r.commits === 1 ? "" : "s"} on ${r.branch} ${r.commits === 1 ? "is" : "are"} not merged, pushed or in a pull request.`,
    )
    .join(" ");
}
