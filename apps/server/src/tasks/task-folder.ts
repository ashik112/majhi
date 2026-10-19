import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { slugOfName } from "@majhi/shared";
import { UserError } from "../errors.ts";

/**
 * Where a new task lives: `<tasks_dir>/<project>/<name-slug>`, the first project of the task or the
 * workspace's name when it has none, with `-2`, `-3` ... when the name is taken in that project. The
 * folder is stored on the task and every reader uses it; nothing rebuilds it from the id. The slug is
 * `slugOfName`, the same one the branch uses.
 */

/** The folder name for a task name: `login-redirect`. Never empty, never more than one path part. */
export function nameSlug(name: string): string {
  return slugOfName(name) || "task";
}

/** The part under `tasks_dir` that groups folders: a project id, or a workspace name as a slug. */
export function scopeSlug(scope: string): string {
  return slugOfName(scope) || "workspace";
}

/** True when `part` is one plain folder name: not empty, not `.` or `..`, no separators, not hidden. */
export function isPlainFolderName(part: string): boolean {
  return (
    part !== "" &&
    part !== "." &&
    part !== ".." &&
    !part.startsWith(".") &&
    !part.includes("/") &&
    !part.includes("\\") &&
    !part.includes("\0")
  );
}

/** Whether `path` is strictly inside `root`: not `root` itself, not outside it, not through `..`. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The folder wanted for a task: `<tasks_dir>/<scope>/<slug>`, refused when either part is not one
 * plain folder name or the result would not stay under `tasks_dir`.
 */
export function wantedFolder(tasksDir: string, scope: string, slug: string): string {
  const parts = [scope, slug];
  const bad = parts.find((p) => !isPlainFolderName(p));
  if (bad !== undefined) throw new UserError(`"${bad}" cannot be a folder name.`, 409);
  const path = join(tasksDir, scope, slug);
  if (!isInside(tasksDir, path)) throw new UserError(`${path} is outside the tasks folder.`, 409);
  return path;
}

/**
 * Creates the task's folder and returns its path. The first free name wins: `slug`, `slug-2`,
 * `slug-3` ... Creating it is the claim, so two tasks made at once never share one.
 */
export async function claimTaskFolder(tasksDir: string, scope: string, slug: string): Promise<string> {
  wantedFolder(tasksDir, scope, slug);
  const parent = join(tasksDir, scope);
  await mkdir(parent, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const path = wantedFolder(tasksDir, scope, n === 1 ? slug : `${slug}-${n}`);
    try {
      await mkdir(path);
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new UserError(`Could not find a free folder name in ${parent}.`, 409);
}

/**
 * The folder to delete for a removed task, or undefined when it is not one majhi may delete: it must
 * exist and, once links are resolved, lie strictly inside the tasks folder.
 */
export async function removableFolder(tasksDir: string, folder: string): Promise<string | undefined> {
  const root = await realpath(tasksDir).catch(() => undefined);
  const real = await realpath(folder).catch(() => undefined);
  if (root === undefined || real === undefined) return undefined;
  return isInside(root, real) ? real : undefined;
}
