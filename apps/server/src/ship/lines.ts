import type { TaskRepo } from "@majhi/shared";
import { git } from "../git/git.ts";
import { changeBase } from "../git/since-start.ts";

/**
 * Added plus removed lines one repo's branch carries into its base: what a merge or a merge request
 * adds, measured from where the branch meets its base now. Undefined when git cannot say or a binary
 * file is in it, so a rule that limits lines never covers a change whose size is not known.
 */
export async function changedLinesOf(
  repo: Pick<TaskRepo, "source" | "base" | "branch" | "startCommit">,
): Promise<number | undefined> {
  const tip = `refs/heads/${repo.branch}`;
  try {
    const from = await changeBase(repo.source, repo, tip, { mergeBase: true });
    const out = await git(repo.source, ["diff", "--numstat", "--no-renames", from.commit, tip]);
    return linesOfNumstat(out);
  } catch {
    return undefined;
  }
}

/** The total of `git diff --numstat` output. A binary file ("-") makes the size unknown. */
export function linesOfNumstat(out: string): number | undefined {
  let total = 0;
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const [added, removed] = line.split("\t");
    const a = Number(added);
    const r = Number(removed);
    if (!Number.isInteger(a) || !Number.isInteger(r)) return undefined;
    total += a + r;
  }
  return total;
}

/** The size of a task's change across its writing repos, or undefined when any repo's is not known. */
export async function changedLinesOfTask(
  repos: readonly Pick<TaskRepo, "source" | "base" | "branch" | "startCommit" | "writes">[],
): Promise<number | undefined> {
  let total = 0;
  for (const repo of repos) {
    if (repo.writes === false) continue;
    const lines = await changedLinesOf(repo);
    if (lines === undefined) return undefined;
    total += lines;
  }
  return total;
}
