import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { type DirEntry, type DirListing, expandHome } from "@majhi/shared";
import { errorCode, errorMessage } from "./errors.ts";

/** Folders beyond this many are left out and the listing says `truncated`. */
export const MAX_ENTRIES = 500;

/** Never offered at the top of home: system data, not projects. */
const HIDDEN_AT_HOME = "Library";

const byName = new Intl.Collator("en", { sensitivity: "base", numeric: true });

interface Candidate {
  name: string;
  /** Where the entry is, inside the listed folder. */
  path: string;
  /** The folder it points to: itself, or a symlink's target. */
  target: string;
  hidden: boolean;
}

/**
 * Lists the subfolders of `params.path` (`~` expands to `home`), sorted by
 * name without regard to case. Symlinks to folders are listed under their own
 * name. Throws an Error with a message fit to show when the folder cannot be read.
 */
export async function listDirs(
  params: { path: string; showHidden: boolean },
  home: string,
): Promise<DirListing> {
  const requested = expandHome(params.path, home);
  if (!isAbsolute(requested)) throw new Error("Use an absolute path, or one starting with ~/");

  let dir: string;
  let entries: Dirent[];
  try {
    dir = await realpath(requested);
    if (!(await stat(dir)).isDirectory()) throw new Error(`${requested} is not a folder`);
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw describeError(err, requested);
  }
  const realHome = await realpath(home).catch(() => home);

  const found = await Promise.all(
    entries.map(async (entry): Promise<Candidate | undefined> => {
      const hidden = entry.name.startsWith(".");
      if (hidden && !params.showHidden) return undefined;
      if (dir === realHome && entry.name === HIDDEN_AT_HOME) return undefined;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return { name: entry.name, path, target: path, hidden };
      if (!entry.isSymbolicLink()) return undefined;
      const target = await folderBehind(path);
      return target === undefined ? undefined : { name: entry.name, path, target, hidden };
    }),
  );
  const candidates = found.filter((c) => c !== undefined);
  candidates.sort((a, b) => byName.compare(a.name, b.name) || (a.name < b.name ? -1 : 1));

  const kept = candidates.slice(0, MAX_ENTRIES);
  const repos = await Promise.all(kept.map((c) => hasGitDir(c.target)));
  const listed = kept.map(
    (c, i): DirEntry => ({ name: c.name, path: c.path, isRepo: repos[i] === true, hidden: c.hidden }),
  );
  return {
    path: dir,
    parent: dir === "/" ? null : dirname(dir),
    home: realHome,
    entries: listed,
    truncated: candidates.length > kept.length,
  };
}

/** The real folder a symlink points to, or undefined for a broken link or a link to a file. */
async function folderBehind(link: string): Promise<string | undefined> {
  try {
    const target = await realpath(link);
    return (await stat(target)).isDirectory() ? target : undefined;
  } catch {
    return undefined;
  }
}

/** True when `dir/.git` is a real directory. A `.git` file (worktree, submodule) or symlink does not count. */
async function hasGitDir(dir: string): Promise<boolean> {
  try {
    return (await lstat(join(dir, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

function describeError(err: unknown, path: string): Error {
  switch (errorCode(err)) {
    case "ENOENT":
      return new Error(`There is no folder at ${path}`);
    case "ENOTDIR":
      return new Error(`${path} is not a folder`);
    case "EACCES":
    case "EPERM":
      return new Error(`majhi does not have permission to read ${path}`);
    case "ELOOP":
      return new Error(`${path} is a symlink that points back to itself`);
    case undefined:
      return err instanceof Error ? err : new Error(String(err));
    default:
      return new Error(`Cannot read ${path}: ${errorMessage(err)}`);
  }
}
