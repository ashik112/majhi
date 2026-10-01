import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { UserError } from "../errors.ts";

/** True when `path` is `root` or inside it. Both must already be normalised. */
export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function realOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * The normalised path to open, when it exists and is a workspace root, the tasks folder, a
 * registered project or something inside one. A link that leads out of them is refused too. The editor opens only what
 * majhi works with, not any file an agent or a bad request names.
 */
export async function editorPath(path: string, allowed: readonly string[]): Promise<string> {
  if (!isAbsolute(path)) throw new UserError("Give an absolute path.", 400);
  if (path.includes("\0")) throw new UserError("That path is not valid.", 400);
  const target = resolve(path);
  const roots = allowed.map((root) => resolve(root));
  if (!roots.some((root) => isInside(target, root))) {
    throw new UserError(`${target} is not in a workspace root or the tasks folder.`, 400);
  }
  const actual = await realpath(target).catch(() => undefined);
  if (actual === undefined) throw new UserError(`There is nothing at ${target}.`, 404);
  const actualRoots = await Promise.all(roots.map(realOr));
  if (!actualRoots.some((root) => isInside(actual, root))) {
    throw new UserError(`${target} leads outside the workspace roots.`, 400);
  }
  return target;
}
