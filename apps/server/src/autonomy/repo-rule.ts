/**
 * The repo rule (SPEC 5.18): the captain does not start a task whose plan touches the same
 * top-level areas of a repo and base branch as a task that is running now. Each task works in its
 * own worktree and ships into one branch one at a time, so tasks on one repo run side by side unless
 * both plans name the same areas. With nothing known about either plan, they run. Pure: the service
 * gathers the inputs. The owner's own starts never come here.
 */

/** One repo a task changes, with the top-level areas it is expected to touch. */
export interface RepoUse {
  project: string;
  base: string;
  /** From `areasOf`. Empty when nothing is known about the plan: it blocks nothing. */
  areas: readonly string[];
}

export interface RepoRuleTask {
  id: string;
  repos: readonly RepoUse[];
}

/** The top-level area of a path: its first folder, or "." for a file at the repo root. */
export function areaOf(path: string): string {
  const clean = path.replace(/^\.?\/+/, "");
  const i = clean.indexOf("/");
  return i === -1 ? "." : clean.slice(0, i);
}

export function areasOf(paths: readonly string[]): string[] {
  return [...new Set(paths.map(areaOf))].sort();
}

/** Only plans that name the same area overlap; an unknown plan overlaps nothing. */
function overlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.includes(x));
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
      if (theirs !== undefined && overlap(mine.areas, theirs.areas)) {
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
