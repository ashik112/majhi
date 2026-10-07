import type { TaskRepo } from "@majhi/shared";
import { git } from "../git/git.ts";

/** The tip of a branch in a project's checkout, or "" when the branch is not there. */
export const branchTip = async (source: string, branch: string): Promise<string> =>
  (await git(source, ["rev-parse", "--verify", `refs/heads/${branch}`]).catch(() => "")).trim();

type RepoTips = Pick<TaskRepo, "project" | "source" | "branch" | "base">;

/**
 * The state of a task's work, one entry per repo ("acme-api@3f9a1c0d2b7e"): the tip of its branch. Everything keyed
 * by "this head of the task" (the ship key, the deploy plan answer) reads it from here.
 */
export async function headsOf(repos: readonly RepoTips[]): Promise<string> {
  const heads: string[] = [];
  for (const r of repos) heads.push(`${r.project}@${(await branchTip(r.source, r.branch)).slice(0, 12)}`);
  return heads.join(",");
}

/** The tip of the branch each repo goes onto, in the same form. */
export async function basesOf(repos: readonly RepoTips[]): Promise<string> {
  const bases: string[] = [];
  for (const r of repos) bases.push(`${r.project}@${(await branchTip(r.source, r.base)).slice(0, 12)}`);
  return bases.join(",");
}
