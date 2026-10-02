import { randomUUID } from "node:crypto";
import { rename, rm, stat, writeFile } from "node:fs/promises";

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
