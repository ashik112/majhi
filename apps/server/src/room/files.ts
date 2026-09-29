import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Task } from "@majhi/shared";
import { listFiles } from "../git/git.ts";

export const FILE_CACHE_MS = 5_000;
export const MAX_FILE_RESULTS = 50;

export interface FileHit {
  /**
   * Relative to the task folder, which is the agent's working directory: `<project>/<path in repo>`,
   * or a task folder file. Registered projects are absolute paths.
   */
  path: string;
  /** The project, `task` for task folder files, or `project` for a registered project itself. */
  repo: string;
}

/** Folders never listed from the task folder. */
const SKIP = new Set(["node_modules", "dist", "build", "target", "vendor"]);
const TASK_FOLDER_LIMIT = 5000;

/** File names across a task's worktrees, from `git ls-files`, cached for a few seconds per worktree. */
export class FileIndex {
  private readonly cache = new Map<string, { at: number; files: Promise<string[]> }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly list: (cwd: string) => Promise<string[]> = listFiles,
    /** Registered projects, offered by name in every task (chats have no worktrees). */
    private readonly projects: () => Promise<{ id: string; path: string }[]> = async () => [],
  ) {}

  async search(task: Pick<Task, "repos" | "folder">, query: string): Promise<FileHit[]> {
    const trees = task.repos.flatMap((r) =>
      r.worktree === undefined ? [] : [{ repo: r.project, path: r.worktree }],
    );
    const lists = await Promise.all(
      trees.map(async (t) => ({ repo: t.repo, files: await this.files(t.path).catch(() => [] as string[]) })),
    );
    const scored: { hit: FileHit; score: number; inRepo: string }[] = [];
    const q = query.trim().toLowerCase();
    const add = (hit: FileHit, inRepo: string) => {
      const score = q === "" ? 0 : scoreMatch(inRepo, q);
      if (score !== undefined) scored.push({ hit, score, inRepo });
    };
    for (const { repo, files } of lists) {
      for (const path of files) add({ path: `${repo}/${path}`, repo }, path);
    }
    const inTrees = new Set(trees.map((t) => relative(task.folder, t.path)));
    for (const path of await this.taskFiles(task.folder, inTrees)) add({ path, repo: "task" }, path);
    for (const project of await this.projects().catch(() => [])) {
      add({ path: project.path, repo: "project" }, project.id);
    }
    scored.sort(
      (a, b) =>
        a.score - b.score ||
        a.inRepo.length - b.inRepo.length ||
        (a.hit.path < b.hit.path ? -1 : a.hit.path > b.hit.path ? 1 : 0),
    );
    return scored.slice(0, MAX_FILE_RESULTS).map((s) => s.hit);
  }

  /** Files in the task folder itself (TASK.md, attachments, media), skipping worktrees and hidden folders. */
  private taskFiles(folder: string, worktrees: Set<string>): Promise<string[]> {
    const hit = this.cache.get(`task:${folder}`);
    if (hit !== undefined && this.now() - hit.at < FILE_CACHE_MS) return hit.files;
    const files = walk(folder, "", worktrees);
    this.cache.set(`task:${folder}`, { at: this.now(), files });
    files.catch(() => this.cache.delete(`task:${folder}`));
    return files;
  }

  private files(worktree: string): Promise<string[]> {
    const hit = this.cache.get(worktree);
    if (hit !== undefined && this.now() - hit.at < FILE_CACHE_MS) return hit.files;
    const files = this.list(worktree);
    this.cache.set(worktree, { at: this.now(), files });
    files.catch(() => this.cache.delete(worktree));
    return files;
  }
}

/** Lower is better. Undefined when the query does not match. Case-insensitive. */
export function scoreMatch(path: string, query: string): number | undefined {
  const lower = path.toLowerCase();
  const slash = lower.lastIndexOf("/");
  const name = lower.slice(slash + 1);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (lower.includes(query)) return 3;
  return isSubsequence(query, name) ? 4 : isSubsequence(query, lower) ? 5 : undefined;
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

async function walk(root: string, sub: string, skip: Set<string>, out: string[] = []): Promise<string[]> {
  if (out.length >= TASK_FOLDER_LIMIT) return out;
  const entries = await readdir(join(root, sub), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const path = sub === "" ? entry.name : `${sub}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skip.has(path)) await walk(root, path, skip, out);
    } else if (entry.isFile()) {
      out.push(path);
    }
    if (out.length >= TASK_FOLDER_LIMIT) break;
  }
  return out;
}
