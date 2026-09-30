import { basename } from "node:path";
import { git } from "../git/git.ts";

/**
 * Checkpoints (SPEC 5.7): after every turn that changed files, a WIP commit on the task branch
 * in each touched worktree, `wip(<task>): checkpoint N`. Never pushed. Git runs with hooks and
 * signing off, so the owner's setup cannot block or prompt.
 */

export interface Identity {
  name: string;
  email: string;
}

/** More new files than this in one checkpoint is a cache or build folder, not work. */
export const MAX_NEW_FILES = 2000;

/** Used when the org has no commit identity. */
export const DEFAULT_IDENTITY: Identity = { name: "majhi", email: "majhi@majhi.local" };

export interface CheckpointRepo {
  project: string;
  worktree: string;
  /** The task branch. A worktree on another branch is left alone. */
  branch: string;
  base: string;
}

export function checkpointMessage(task: string, n: number): string {
  return `wip(${task}): checkpoint ${n}`;
}

function quiet(identity: Identity): string[] {
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

export interface CheckpointResult {
  /** Projects that got a commit. */
  committed: string[];
  /** One line per worktree that was skipped for a reason the owner should know. */
  skipped: string[];
}

/** Commits every changed worktree as checkpoint `n`. Worktrees without changes are skipped silently. */
export async function commitCheckpoint(
  repos: readonly CheckpointRepo[],
  task: string,
  n: number,
  identity: Identity,
): Promise<CheckpointResult> {
  const result: CheckpointResult = { committed: [], skipped: [] };
  for (const repo of repos) {
    try {
      const status = await git(repo.worktree, ["status", "--porcelain"]);
      if (status.trim() === "") continue;
      const head = (
        await git(repo.worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")
      ).trim();
      if (head !== repo.branch) {
        result.skipped.push(
          `${repo.project}: not on ${repo.branch}${head === "" ? "" : ` (on ${head})`}, so no checkpoint was made there`,
        );
        continue;
      }
      await git(repo.worktree, [...quiet(identity), "add", "--all"]);
      // A cache or build folder that is not ignored (a package store, say) must not land in the
      // branch: thousands of new files in one checkpoint are never the agent's work.
      const added = (await git(repo.worktree, ["diff", "--cached", "--name-only", "--diff-filter=A"]))
        .split("\n")
        .filter((f) => f !== "");
      if (added.length > MAX_NEW_FILES) {
        await git(repo.worktree, ["reset", "--quiet"]);
        const top = [...new Set(added.map((f) => f.split("/")[0]))].slice(0, 3).join(", ");
        result.skipped.push(
          `${repo.project}: ${added.length} new files (in ${top}), which looks like a cache or build folder, so no checkpoint was made. Add it to .gitignore`,
        );
        continue;
      }
      await git(repo.worktree, [
        ...quiet(identity),
        "commit",
        "--quiet",
        "--no-verify",
        "--message",
        checkpointMessage(task, n),
      ]);
      result.committed.push(repo.project);
    } catch (err) {
      result.skipped.push(`${repo.project}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** Where the task branch left its base, or HEAD when that cannot be found. */
async function forkPoint(repo: CheckpointRepo): Promise<string> {
  const out = await git(repo.worktree, ["merge-base", "HEAD", repo.base]).catch(() => "");
  return out.trim() || "HEAD";
}

/** `git diff --stat` from the fork point to the working tree, per repo, headed by the project. */
export async function diffStat(repos: readonly CheckpointRepo[]): Promise<string> {
  const parts: string[] = [];
  for (const repo of repos) {
    const stat = await git(repo.worktree, ["diff", "--stat", await forkPoint(repo)]).catch(() => "");
    if (stat.trim() !== "") parts.push(`${repo.project || basename(repo.worktree)}:\n${stat.trimEnd()}`);
  }
  return parts.join("\n\n");
}

/** The stat plus the diff itself, per repo, cut at `max` characters. */
export async function diffText(repos: readonly CheckpointRepo[], max: number): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  for (const repo of repos) {
    if (used >= max) break;
    const base = await forkPoint(repo);
    const stat = await git(repo.worktree, ["diff", "--stat", base]).catch(() => "");
    if (stat.trim() === "") continue;
    const diff = await git(repo.worktree, ["diff", base]).catch(() => "");
    const part = `${repo.project}:\n${stat.trimEnd()}\n\n${diff}`.slice(0, max - used);
    parts.push(part);
    used += part.length;
  }
  return parts.join("\n\n");
}
