import { basename } from "node:path";
import { agentCommitter, withTaskTrailer } from "@majhi/shared";
import { git } from "../git/git.ts";

/**
 * Checkpoints (SPEC 5.7): after every turn that changed files, a WIP commit on the task branch
 * in each touched worktree, `wip(<task>): checkpoint N`, authored as the org and committed by the
 * agent that ran the turn, with a `Majhi-Task` trailer. Never pushed. Git runs with hooks and
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

/**
 * Who a commit is made as: the org's identity as author, the agent (or majhi itself) as committer,
 * and the task its message links to.
 */
export interface CommitBy {
  author: Identity;
  committer: Identity;
  /** The task the message links to. Absent when attribution is off. */
  task: string | undefined;
}

/**
 * A commit an agent made, or one majhi made itself when there is no agent. With attribution off
 * the org's identity is both author and committer, and there is no trailer.
 */
export function commitBy(author: Identity, task: string, agent?: string, attribute = true): CommitBy {
  if (!attribute) return unattributed({ author, committer: author, task });
  return { author, committer: agent === undefined ? DEFAULT_IDENTITY : agentCommitter(agent), task };
}

/** The same commit made with attribution off. */
export function unattributed(by: CommitBy): CommitBy {
  return { author: by.author, committer: by.author, task: undefined };
}

/** The message with the task trailer, when the commit is attributed. */
function messageFor(message: string, by: CommitBy): string {
  return by.task === undefined ? message : withTaskTrailer(message, by.task);
}

export interface CheckpointRepo {
  project: string;
  worktree: string;
  /** The task branch. A worktree on another branch is left alone. */
  branch: string;
  base: string;
  /** False: commits here are not attributed to an agent or a task. Default true. */
  attribution?: boolean;
}

export function checkpointMessage(task: string, n: number): string {
  return `wip(${task}): checkpoint ${n}`;
}

function quiet(): string[] {
  return ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
}

/** Author and committer by environment, which wins over the server's own `GIT_*` variables and the repo's config. */
function asEnv(by: CommitBy): { env: Record<string, string> } {
  return {
    env: {
      GIT_AUTHOR_NAME: by.author.name,
      GIT_AUTHOR_EMAIL: by.author.email,
      GIT_COMMITTER_NAME: by.committer.name,
      GIT_COMMITTER_EMAIL: by.committer.email,
    },
  };
}

/** One commit of everything changed in a worktree, for a change majhi makes itself. Not a checkpoint. */
export async function commitAll(worktree: string, message: string, by: CommitBy): Promise<void> {
  await git(worktree, [...quiet(), "add", "--all"]);
  await git(
    worktree,
    [...quiet(), "commit", "--quiet", "--no-verify", "--message", messageFor(message, by)],
    asEnv(by),
  );
}

/**
 * Commits only `paths` (from the worktree's top, taken literally) with `message`. Returns the new
 * commit, or undefined when those files already held that content and there was nothing to commit.
 */
export async function commitPaths(
  worktree: string,
  paths: readonly string[],
  message: string,
  by: CommitBy,
): Promise<string | undefined> {
  const literal = { env: { GIT_LITERAL_PATHSPECS: "1" } };
  await git(worktree, [...quiet(), "add", "--", ...paths], literal);
  const staged = await git(worktree, ["diff", "--cached", "--name-only", "--", ...paths], literal);
  if (staged.trim() === "") return undefined;
  await git(
    worktree,
    [...quiet(), "commit", "--quiet", "--no-verify", "--message", messageFor(message, by), "--", ...paths],
    { env: { ...asEnv(by).env, ...literal.env } },
  );
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
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
  by: CommitBy,
): Promise<CheckpointResult> {
  const result: CheckpointResult = { committed: [], skipped: [] };
  for (const repo of repos) {
    const repoBy = repo.attribution === false ? unattributed(by) : by;
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
      await git(repo.worktree, [...quiet(), "add", "--all"]);
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
      await git(
        repo.worktree,
        [
          ...quiet(),
          "commit",
          "--quiet",
          "--no-verify",
          "--message",
          messageFor(checkpointMessage(task, n), repoBy),
        ],
        asEnv(repoBy),
      );
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

/** Every worktree's HEAD commit, joined, so two readings differ exactly when a repo got a commit. */
export async function headsOf(repos: readonly CheckpointRepo[]): Promise<string> {
  const heads: string[] = [];
  for (const repo of repos) {
    heads.push((await git(repo.worktree, ["rev-parse", "HEAD"]).catch(() => "")).trim());
  }
  return heads.join(" ");
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
