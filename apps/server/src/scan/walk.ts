import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { errorCode, errorMessage } from "../errors.ts";

/** Runs at most `size` tasks at a time. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(size: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    // A finishing task hands its slot straight to the next waiter.
    if (active >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

export interface WalkOptions {
  /** How many levels below the root to look. The root is level 0. */
  maxDepth: number;
  /** Absolute paths never entered, like the tasks folder. */
  skip: ReadonlySet<string>;
  limit: Limiter;
}

export interface WalkResult {
  /** Absolute paths of folders with a `.git` directory. */
  repos: string[];
  /** Folders that could not be read, as `relPath: reason`. */
  errors: string[];
}

/**
 * Finds git repos under `root`. Never follows symlinks, never enters a repo,
 * `node_modules`, a hidden folder or a skipped path, and skips folders whose
 * `.git` is a file (worktrees and submodules).
 */
export async function findRepos(root: string, options: WalkOptions): Promise<WalkResult> {
  const repos: string[] = [];
  const errors: string[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await options.limit(() => readdir(dir, { withFileTypes: true }));
    } catch (err) {
      const code = errorCode(err);
      // The folder went away mid-scan. Nothing to report.
      if (code === "ENOENT" || code === "ENOTDIR") return;
      const reason = code === "EACCES" || code === "EPERM" ? "permission denied" : errorMessage(err);
      errors.push(`${relative(root, dir) || "."}: ${reason}`);
      return;
    }

    const git = entries.find((e) => e.name === ".git");
    if (git !== undefined) {
      if (git.isDirectory()) repos.push(dir);
      return;
    }
    if (depth >= options.maxDepth) return;

    const children: Promise<void>[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = join(dir, entry.name);
      if (!options.skip.has(child)) children.push(visit(child, depth + 1));
    }
    await Promise.all(children);
  };

  await visit(root, 0);
  return { repos, errors };
}
