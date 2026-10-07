import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { expandHome } from "@majhi/shared";

/**
 * Makes a project folder (and the folders above it) under the owner's home. Anywhere else is refused,
 * and an existing folder is left as it is. Throws an Error with a message fit to show.
 */
export async function makeDir(params: { path: string }, home: string): Promise<{ path: string }> {
  const requested = resolve(expandHome(params.path, home));
  if (!isAbsolute(requested)) throw new Error("Use an absolute path, or one starting with ~/");
  const inside = relative(resolve(home), requested);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error("majhi only makes folders inside your home folder.");
  }
  const existing = await stat(requested).catch(() => undefined);
  if (existing !== undefined && !existing.isDirectory())
    throw new Error(`${requested} is a file, not a folder.`);
  await mkdir(requested, { recursive: true });
  return { path: requested };
}
