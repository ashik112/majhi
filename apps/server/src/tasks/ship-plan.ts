import type { TaskRepo } from "@majhi/shared";
import { UserError } from "../errors.ts";
import { localBranchExists, uncommitted } from "../git/git.ts";
import { commitsSinceStart } from "../git/since-start.ts";

/**
 * Which repos of a task a ship sends, and into which branch. A repo the task did not change is left
 * out of every ship action (merge, push, merge request, delete after). Each repo goes into its own
 * base unless the caller named another branch for it: a single `into` only covers repos that share
 * one base, or whose base it is, so a repo is never merged into another repo's base by accident.
 */

export interface ShipTargets {
  /** One target: for every repo when they share a base, else only for repos whose base it is. */
  into?: string | undefined;
  /** The target per project. Wins over `into`. */
  targets?: Readonly<Record<string, string>> | undefined;
}

export interface ShipPlan {
  /** Repos with changes, each with the branch it ships into, in the task's order. */
  ship: { repo: TaskRepo; into: string }[];
  /** Repos with no change since the task started. */
  unchanged: TaskRepo[];
}

export const NO_CHANGES = "No changes since the task started, skipped.";

/**
 * True when the task did work in the repo: a commit since it started, or tracked changes not
 * committed yet. Untracked files alone do not count: no ship action sends them. A branch that is
 * gone has nothing to ship. When git cannot say, the repo counts as changed, so it is never
 * skipped by mistake.
 */
export async function repoChanged(repo: TaskRepo): Promise<boolean> {
  const exists = await localBranchExists(repo.source, repo.branch).catch(() => true);
  if (!exists) return false;
  const commits = await commitsSinceStart(repo.source, repo).catch(() => undefined);
  if (commits === undefined || commits > 0) return true;
  if (repo.worktree === undefined) return false;
  const dirty = await uncommitted(repo.worktree).catch(() => []);
  return dirty.some((l) => !l.startsWith("??"));
}

/** Splits repos into changed and unchanged, keeping their order. */
export async function splitChanged(
  repos: readonly TaskRepo[],
): Promise<{ changed: TaskRepo[]; unchanged: TaskRepo[] }> {
  const changed: TaskRepo[] = [];
  const unchanged: TaskRepo[] = [];
  for (const repo of repos) ((await repoChanged(repo)) ? changed : unchanged).push(repo);
  return { changed, unchanged };
}

/**
 * The branch each repo ships into. `all` is every repo of the task, to refuse a target for a
 * project the task does not have. Refused when one `into` would send repos on different bases
 * into a branch that is none of theirs.
 */
export function targetsFor(
  repos: readonly TaskRepo[],
  pick: ShipTargets,
  all: readonly TaskRepo[] = repos,
): Map<string, string> {
  for (const project of Object.keys(pick.targets ?? {})) {
    if (!all.some((r) => r.project === project)) {
      throw new UserError(`${project} is not a repo of this task.`, 409);
    }
  }
  const named = (r: TaskRepo) => pick.targets?.[r.project];
  const bases = new Set(repos.map((r) => r.base));
  const rest = repos.filter((r) => named(r) === undefined);
  const into = pick.into;
  if (into !== undefined && bases.size > 1 && rest.length > 0 && !rest.some((r) => r.base === into)) {
    const list = rest.map((r) => `${r.project} on ${r.base}`).join(", ");
    throw new UserError(
      `The repos start from different branches (${list}), so ${into} is not a target for all of them. Pick a target for each repo.`,
      409,
    );
  }
  const out = new Map<string, string>();
  for (const r of repos) {
    const own = named(r);
    if (own !== undefined) out.set(r.project, own);
    else if (into !== undefined && (bases.size <= 1 || r.base === into)) out.set(r.project, into);
    else out.set(r.project, r.base);
  }
  return out;
}

/** The ship plan for `repos`: changed ones with their target, and the ones left out. */
export async function shipPlan(
  repos: readonly TaskRepo[],
  pick: ShipTargets,
  all: readonly TaskRepo[] = repos,
): Promise<ShipPlan> {
  const { changed, unchanged } = await splitChanged(repos);
  const targets = targetsFor(changed, pick, all);
  return {
    ship: changed.map((repo) => ({ repo, into: targets.get(repo.project) ?? repo.base })),
    unchanged,
  };
}

/** The result line for a repo a ship left out. */
export function skippedResult(repo: TaskRepo): {
  project: string;
  into: string;
  ok: true;
  skipped: true;
  detail: string;
} {
  return { project: repo.project, into: repo.base, ok: true, skipped: true, detail: NO_CHANGES };
}

/** The targets of a plan, by project, to hand on to the merge it runs. */
export function planTargets(plan: ShipPlan): Record<string, string> {
  return Object.fromEntries(plan.ship.map((s) => [s.repo.project, s.into]));
}
