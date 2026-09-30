import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { agentOfCommitter, type RepoCommit, type RepoDiff, type RepoDiffFile } from "@majhi/shared";
import { git, listUntracked, localBranchExists } from "./git.ts";

/** Files listed per repo, and patch text kept per file. Past these the owner reads the diff on the host. */
export const MAX_DIFF_FILES = 300;
export const MAX_PATCH_BYTES = 200_000;
/** All patch text of one repo. Past it, files are listed with no patch. */
export const MAX_TOTAL_PATCH_BYTES = 5_000_000;
/** What one `git diff` may print before majhi gives up on reading it. */
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

/** `--no-ext-diff` and `--no-textconv`: a repo's own config never gets to run a program while majhi reads a diff. */
const DIFF_ARGS = [
  "-c",
  "core.quotePath=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "-M",
];
const READ = { maxBufferBytes: MAX_GIT_OUTPUT_BYTES };

type Repo = { project: string; source: string; base: string; branch: string; worktree?: string | undefined };

/**
 * What a task repo changed against its base: the branch's commits since it left the base, plus
 * uncommitted and new files while the worktree exists. The patches are git's own.
 */
export async function repoDiff(repo: Repo): Promise<RepoDiff> {
  const head = { project: repo.project, base: repo.base, branch: repo.branch };
  const empty = { commits: [], files: [], omitted: 0, uncommitted: false };
  try {
    const cwd = repo.worktree ?? repo.source;
    if (repo.worktree === undefined && !(await localBranchExists(repo.source, repo.branch))) {
      return { ...head, ...empty, error: "The branch is gone, so there is nothing to show." };
    }
    const tip = repo.worktree === undefined ? repo.branch : "HEAD";
    const mergeBase = (await git(cwd, ["merge-base", repo.base, tip])).trim();
    const target = repo.worktree === undefined ? [mergeBase, repo.branch] : [mergeBase];
    const names = parseRaw(await git(cwd, [...DIFF_ARGS, "--raw", "-z", ...target], READ));
    const patches = splitPatches(await git(cwd, [...DIFF_ARGS, ...target], READ));
    const tracked = names.map((n, i) => fileOf(n, patches[i] ?? ""));
    const commits = await branchCommits(cwd, mergeBase, tip === "HEAD" ? "HEAD" : repo.branch);
    const files = tracked.slice(0, MAX_DIFF_FILES);
    let omitted = tracked.length - files.length;
    let uncommitted = false;
    if (repo.worktree !== undefined) {
      // Only as many untracked files as the list has room for are opened. The rest are counted.
      const untracked = (await listUntracked(repo.worktree)).toSorted();
      const room = Math.max(0, MAX_DIFF_FILES - files.length);
      const budget = { left: MAX_TOTAL_PATCH_BYTES - files.reduce((sum, f) => sum + f.patch.length, 0) };
      for (const path of untracked.slice(0, room)) files.push(await newFile(repo.worktree, path, budget));
      omitted += Math.max(0, untracked.length - room);
      uncommitted = (await git(repo.worktree, ["status", "--porcelain"])).trim() !== "";
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { ...head, commits, files: withinBudget(files), omitted, uncommitted };
  } catch (err) {
    return { ...head, ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}

const COMMIT_FIELDS = "%H%x1f%s%x1f%cn%x1f%ce%x1f%cI%x1e";
/** Commits listed per repo. A branch with more shows its newest. */
export const MAX_COMMITS = 200;

/** The commits from the merge base to the tip, newest first, each with the agent that committed it. */
export async function branchCommits(cwd: string, mergeBase: string, tip: string): Promise<RepoCommit[]> {
  const out = await git(cwd, [
    "log",
    `--max-count=${MAX_COMMITS}`,
    `--format=${COMMIT_FIELDS}`,
    `${mergeBase}..${tip}`,
  ]);
  return out
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", subject = "", name = "", email = "", at = ""] = record.split("\x1f");
      const agent = agentOfCommitter({ name, email });
      return { sha, subject, ...(agent === undefined ? {} : { agent }), at };
    });
}

/** Keeps patches in order until the repo's total is used up; later files are listed as too large. */
function withinBudget(files: RepoDiffFile[]): RepoDiffFile[] {
  let left = MAX_TOTAL_PATCH_BYTES;
  return files.map((f) => {
    if (f.patch.length <= left) {
      left -= f.patch.length;
      return f;
    }
    return { ...f, patch: "", truncated: true };
  });
}

type Named = { status: RepoDiffFile["status"]; path: string; oldPath?: string };

/** `git diff --raw -z`: `:modes shas STATUS\0path\0`, and two paths for a rename or copy. */
export function parseRaw(raw: string): Named[] {
  const parts = raw.split("\0");
  const out: Named[] = [];
  for (let i = 0; i < parts.length; ) {
    const meta = parts[i++] ?? "";
    if (!meta.startsWith(":")) continue;
    const letter = meta.split(" ").at(-1)?.[0] ?? "M";
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i++] ?? "";
      const path = parts[i++] ?? "";
      out.push(letter === "R" ? { status: "renamed", path, oldPath } : { status: "added", path });
    } else {
      const path = parts[i++] ?? "";
      out.push({ status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified", path });
    }
  }
  return out;
}

/** One chunk per file of a `git diff`, in the order git prints them. */
export function splitPatches(text: string): string[] {
  return text === "" ? [] : text.split(/^(?=diff --git )/m);
}

function fileOf(named: Named, chunk: string): RepoDiffFile {
  const binary = /^(Binary files .* differ|GIT binary patch)$/m.test(chunk);
  const at = chunk.search(/^@@ /m);
  const hunks = at < 0 || binary ? "" : chunk.slice(at);
  const { additions, deletions } = countLines(hunks);
  const truncated = hunks.length > MAX_PATCH_BYTES;
  return {
    ...named,
    additions,
    deletions,
    binary,
    patch: truncated ? "" : hunks,
    truncated,
  };
}

export function countLines(hunks: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of hunks.split("\n")) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/**
 * A file git does not track yet: shown as all added lines. A symbolic link shows where it points,
 * never what it points at, and nothing outside the worktree is opened.
 */
async function newFile(worktree: string, path: string, budget: { left: number }): Promise<RepoDiffFile> {
  const base = { path, status: "added" as const, deletions: 0, binary: false, truncated: false };
  const skipped = { ...base, additions: 0, patch: "" };
  const full = join(worktree, path);
  const info = await lstat(full).catch(() => undefined);
  if (info?.isSymbolicLink()) {
    const target = await readlink(full).catch(() => "");
    return { ...base, additions: 1, patch: `@@ -0,0 +1,1 @@\n+${target}\n` };
  }
  if (!info?.isFile()) return skipped;
  const [root, real] = await Promise.all([realpath(worktree), realpath(full).catch(() => "")]);
  if (!real.startsWith(root + sep)) return skipped;
  if (info.size > MAX_PATCH_BYTES || info.size > budget.left) return { ...skipped, truncated: true };
  const buffer = await readFile(full);
  if (buffer.includes(0)) return { ...skipped, binary: true };
  const lines = buffer.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const patch =
    lines.length === 0 ? "" : `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
  budget.left -= patch.length;
  return { ...base, additions: lines.length, patch };
}
