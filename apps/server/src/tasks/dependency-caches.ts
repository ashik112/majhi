import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { git, gitOk } from "../git/git.ts";

/** Regenerable dependency and tool caches. Source, virtual environments and data are excluded. */
const CACHE_NAMES = new Set([
  "node_modules",
  ".pnpm-store",
  ".next",
  ".nuxt",
  ".turbo",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

/** Only wholly ignored directories inside the real worktree, with no tracked files or symlink escapes. */
export async function dependencyCaches(worktree: string): Promise<string[]> {
  const root = await realpath(worktree);
  const top = await git(worktree, ["rev-parse", "--show-toplevel"]);
  if ((await realpath(top.trim())) !== root) return [];
  const ignored = await git(worktree, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "--no-empty-directory",
    "-z",
  ]);
  const candidates: string[] = [];
  const collect = async (path: string, depth: number): Promise<void> => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    if (CACHE_NAMES.has(basename(path))) {
      candidates.push(path);
      return;
    }
    if (depth >= 8 || basename(path) === ".git") return;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await collect(join(path, entry.name), depth + 1);
    }
  };
  for (const entry of ignored.split("\0")) {
    const name = entry.replace(/\/$/, "");
    if (!entry.endsWith("/")) continue;
    const path = resolve(root, name);
    const rel = relative(root, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    await collect(path, 0);
  }
  const found: string[] = [];
  for (const path of candidates) {
    const rel = relative(root, path);
    // Check each ancestor too: rm must never traverse a symlink to another checkout or cache.
    let parent = root;
    let safe = true;
    for (const part of rel.split(sep)) {
      parent = join(parent, part);
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        safe = false;
        break;
      }
    }
    if (!safe) continue;
    if (!(await gitOk(worktree, ["check-ignore", "--quiet", "--no-index", "--", rel]))) continue;
    if ((await git(worktree, ["ls-files", "-z", "--", `:(literal)${rel}`])) !== "") continue;
    found.push(path);
  }
  return found;
}

/** Recheck immediately before removal. A stale preview grants no authority to delete a new path. */
export async function removeDependencyCache(worktree: string, path: string): Promise<boolean> {
  if (!(await dependencyCaches(worktree)).includes(path)) return false;
  await rm(path, { recursive: true });
  return true;
}
