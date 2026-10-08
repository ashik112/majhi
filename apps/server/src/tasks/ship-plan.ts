import type { TaskRepo } from "@majhi/shared";
import { UserError } from "../errors.ts";
import { gitOk, localBranchExists, uncommitted } from "../git/git.ts";
import { checkedOutAt } from "../git/merge.ts";
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
  /** Changed repos of protected projects, left out: each ships only alone, with its name typed. */
  held: TaskRepo[];
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
  if (commits === undefined) return true;
  // Commits since the start that the base already holds (a reopened task that shipped before) are not new work.
  const landed =
    commits > 0 &&
    (await gitOk(repo.source, [
      "merge-base",
      "--is-ancestor",
      `refs/heads/${repo.branch}`,
      `refs/heads/${repo.base}`,
    ]));
  if (commits > 0 && !landed) return true;
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
    held: [],
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

export const HELD =
  "Protected: not shipped with the others. Ship it alone from its own row in Ship, typing its name.";

/** The result line for a protected repo a ship left out. */
export function heldResult(repo: TaskRepo): {
  project: string;
  into: string;
  ok: true;
  skipped: true;
  detail: string;
} {
  return { project: repo.project, into: repo.base, ok: true, skipped: true, detail: HELD };
}

/**
 * Takes the protected repos out of a plan, unless the call ships exactly one of them alone
 * (`project`) and carries its name typed by the owner (`confirm`). Throws when nothing is left.
 */
export function holdProtected(
  plan: ShipPlan,
  guarded: ReadonlySet<string>,
  pick: { project?: string | undefined; confirmProtected?: string | undefined },
): ShipPlan {
  const held = plan.ship.filter((s) => guarded.has(s.repo.project)).map((s) => s.repo);
  if (held.length === 0) return plan;
  const alone = pick.project !== undefined && plan.ship.length === 1 && held[0]?.project === pick.project;
  if (alone && pick.confirmProtected === pick.project) return plan;
  const ship = plan.ship.filter((s) => !guarded.has(s.repo.project));
  if (ship.length === 0) {
    const names = held.map((r) => r.project).join(", ");
    throw new UserError(
      alone
        ? `${names} is protected. Type its name to ship it.`
        : `${names} ${held.length === 1 ? "is" : "are"} protected and never ships with other repos or by itself. Ship ${held.length === 1 ? "it" : "each"} alone from its own row in Ship, typing its name.`,
      409,
    );
  }
  return { ...plan, ship, held: [...plan.held, ...held] };
}

/** The targets of a plan, by project, to hand on to the merge it runs. */
export function planTargets(plan: ShipPlan): Record<string, string> {
  return Object.fromEntries(plan.ship.map((s) => [s.repo.project, s.into]));
}

/**
 * Why `into` must not be a ship target, or undefined when it may: a task branch, or a branch checked
 * out in a worktree under the tasks folder (another task's), would put this task's work into
 * another task's branch, where only that task's agents are watched.
 */
export async function targetRefusal(
  repo: TaskRepo,
  into: string,
  tasksDir: string,
  /** The branches of every task in this repo: a task's branch has no fixed prefix. */
  taskBranches: ReadonlySet<string> = new Set(),
): Promise<string | undefined> {
  // A branch stacked on a dependency's task branch (5.4a) lands there: majhi chose that base itself.
  if (repo.stack !== undefined && into === repo.stack.branch && into === repo.base) return undefined;
  if (into.startsWith("task/") || taskBranches.has(into)) {
    return `${into} in ${repo.project} is a task branch. Ship into the repo's base or a branch you work on, never a task's branch.`;
  }
  const at = (await checkedOutAt(repo.source).catch(() => new Map<string, string>())).get(into);
  if (at !== undefined && (at === tasksDir || at.startsWith(`${tasksDir}/`))) {
    return `${into} in ${repo.project} is checked out in a task's worktree (${at}). Ship into the repo's base or a branch you work on.`;
  }
  return undefined;
}
