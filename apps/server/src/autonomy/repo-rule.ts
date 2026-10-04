/**
 * The repo rule (SPEC 5.18): the captain does not start a task whose plan touches the same
 * files of a repo and base branch as a task that is running now. Each task works in its
 * own worktree and ships into one branch one at a time, so tasks on one repo run side by side unless
 * both plans name the same file, or a folder that holds the other's. With nothing known about either plan, they run. Pure: the service
 * gathers the inputs. The owner's own starts never come here.
 */

/** One repo a task changes, with the files and folders it is expected to touch. */
export interface RepoUse {
  project: string;
  base: string;
  /** From `pathsOf`. Empty when nothing is known about the plan: it blocks nothing. */
  paths: readonly string[];
}

export interface RepoRuleTask {
  id: string;
  repos: readonly RepoUse[];
}

/** The paths of a plan as folders and files without leading or trailing slashes, once each. */
export function pathsOf(paths: readonly string[]): string[] {
  return [
    ...new Set(paths.map((p) => p.replace(/^\.?\/+/, "").replace(/\/+$/, "")).filter((p) => p !== "")),
  ].sort();
}

/** Two plans overlap when they name the same file, or one names a folder that holds the other's. */
function overlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}

/** The first task in `writers` that blocks `candidate`, with the repo it blocks on. */
export function blockingWriter(
  candidate: RepoRuleTask,
  writers: readonly RepoRuleTask[],
): { task: string; project: string; base: string } | undefined {
  for (const other of writers) {
    if (other.id === candidate.id) continue;
    for (const mine of candidate.repos) {
      // An empty base is a new task whose base is not known yet: it counts as the same base.
      const theirs = other.repos.find(
        (r) => r.project === mine.project && (mine.base === "" || r.base === mine.base),
      );
      if (theirs !== undefined && overlap(mine.paths, theirs.paths)) {
        return { task: other.id, project: mine.project, base: theirs.base };
      }
    }
  }
  return undefined;
}

/**
 * The one line that says why the captain does not start `label`, or undefined when it may. `then`
 * says what happens to the task instead.
 */
export function repoRuleLine(
  label: string,
  candidate: RepoRuleTask,
  writers: readonly RepoRuleTask[],
  then: string,
): string | undefined {
  const block = blockingWriter(candidate, writers);
  if (block === undefined) return undefined;
  return `Not starting ${label}: ${block.task} is already changing ${block.project} on ${block.base}. ${then}`;
}
