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
