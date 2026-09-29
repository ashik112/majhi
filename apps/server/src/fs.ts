import { stat } from "node:fs/promises";

/** True when `path` is a folder the server can see. Follows symlinks. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
