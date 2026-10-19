import { randomUUID } from "node:crypto";
import { rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

/**
 * The one path containment rule: true when `path` is `root` or lies inside it. It reads the paths as
 * written (no symlinks), so a caller that must stop links resolves both with `realpath` first. A name
 * that only starts with dots (`..cache`) is inside; `..` and `../x` are not.
 */
export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** True when `path` lies inside `root` and is not `root` itself. Same reading rules as `isInside`. */
export function isBelow(path: string, root: string): boolean {
  return isInside(path, root) && relative(root, path) !== "";
}

/** True when `path` is a folder the server can see. Follows symlinks. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Writes a file through a temporary file and a rename, so a reader sees the old text or the new
 * one, never an empty or half-written file, even when two writes overlap.
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * What identifies the contents of a file on disk: a write, a hand edit or a rename over it changes
 * one of these (the times to the nanosecond). Throws like `stat` when the file is not there.
 */
export async function fileSignature(path: string): Promise<string> {
  const s = await stat(path, { bigint: true });
  return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}
