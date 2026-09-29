import type { Task } from "@majhi/shared";
import { listFiles } from "../git/git.ts";

export const FILE_CACHE_MS = 5_000;
export const MAX_FILE_RESULTS = 50;

export interface FileHit {
  /** Relative to the task folder, which is the agent's working directory: `<project>/<path in repo>`. */
  path: string;
  repo: string;
}

/** File names across a task's worktrees, from `git ls-files`, cached for a few seconds per worktree. */
export class FileIndex {
  private readonly cache = new Map<string, { at: number; files: Promise<string[]> }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly list: (cwd: string) => Promise<string[]> = listFiles,
  ) {}

  async search(task: Pick<Task, "repos">, query: string): Promise<FileHit[]> {
    const trees = task.repos.flatMap((r) =>
      r.worktree === undefined ? [] : [{ repo: r.project, path: r.worktree }],
    );
    const lists = await Promise.all(
      trees.map(async (t) => ({ repo: t.repo, files: await this.files(t.path).catch(() => [] as string[]) })),
    );
    const scored: { hit: FileHit; score: number; inRepo: string }[] = [];
    const q = query.trim().toLowerCase();
    for (const { repo, files } of lists) {
      for (const path of files) {
        const score = q === "" ? 0 : scoreMatch(path, q);
        if (score !== undefined) scored.push({ hit: { path: `${repo}/${path}`, repo }, score, inRepo: path });
      }
    }
    scored.sort(
      (a, b) =>
        a.score - b.score ||
        a.inRepo.length - b.inRepo.length ||
        (a.hit.path < b.hit.path ? -1 : a.hit.path > b.hit.path ? 1 : 0),
    );
    return scored.slice(0, MAX_FILE_RESULTS).map((s) => s.hit);
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
