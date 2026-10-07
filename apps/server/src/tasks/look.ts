import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Task, TaskLook } from "@majhi/shared";
import { UserError } from "../errors.ts";
import { uncommitted } from "../git/git.ts";
import { commitsSinceStart } from "../git/since-start.ts";

/** The most of a file `tasks.look` returns. */
export const LOOK_FILE_BYTES = 100_000;
/** The most entries of a folder it lists. */
export const LOOK_ENTRIES = 300;
/** The most `git status` lines per repo. */
export const LOOK_CHANGES = 200;

/**
 * What an agent that does not work in a task may read of it, read-only: each repo's branch and
 * `git status`, then one folder's entries or one file. A path stays inside the repo's worktree (also
 * through symlinks), and a name that starts with a dot is never read: no `.git`, no `.env`.
 */
export async function lookAtTask(
  task: Task,
  input: { project?: string | undefined; path?: string | undefined },
): Promise<TaskLook> {
  const repos = await Promise.all(
    task.repos.map(async (r) => {
      if (r.worktree === undefined) {
        return { project: r.project, branch: r.branch, base: r.base, worktree: false, changes: [] };
      }
      const changes = await uncommitted(r.worktree).catch(() => ["Could not read this worktree"]);
      const commits = await commitsSinceStart(r.worktree, r).catch(() => undefined);
      return {
        project: r.project,
        branch: r.branch,
        base: r.base,
        worktree: true,
        changes: changes.slice(0, LOOK_CHANGES),
        ...(commits === undefined ? {} : { commits }),
      };
    }),
  );
  const look: TaskLook = { id: task.id, status: task.status, repos };
  if (input.path === undefined) return look;

  const repo =
    input.project === undefined
      ? task.repos.length === 1
        ? task.repos[0]
        : undefined
      : task.repos.find((r) => r.project === input.project);
  if (repo === undefined) {
    throw new UserError(
      input.project === undefined
        ? `${task.id} has ${task.repos.length} repos: give project (${task.repos.map((r) => r.project).join(", ")}).`
        : `${task.id} has no repo ${input.project}.`,
      409,
    );
  }
  if (repo.worktree === undefined) {
    throw new UserError(`${repo.project} has no working folder yet: ${task.id} has not started.`, 409);
  }
  const parts = input.path.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || p.startsWith(".") || p.includes("\0") || p.includes("\\"))) {
    throw new UserError("That path is not readable: no parent folders, no names that start with a dot.", 409);
  }
  const root = await realpath(repo.worktree).catch(() => undefined);
  const target = root === undefined ? undefined : await realpath(join(root, ...parts)).catch(() => undefined);
  if (root === undefined || target === undefined) throw new UserError(`${input.path} does not exist.`, 404);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.split(sep).some((p) => p.startsWith("."))) {
    throw new UserError("That path is outside the repo.", 409);
  }
  const info = await stat(target);
  if (info.isDirectory()) {
    const names = await readdir(target, { withFileTypes: true });
    const entries = names
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, LOOK_ENTRIES);
    return { ...look, entries };
  }
  if (!info.isFile()) throw new UserError(`${input.path} is not a file or a folder.`, 409);
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(Math.min(info.size, LOOK_FILE_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.includes(0)) throw new UserError(`${input.path} is a binary file.`, 409);
    return {
      ...look,
      file: {
        project: repo.project,
        path: parts.join("/"),
        content: buffer.toString("utf8"),
        truncated: info.size > LOOK_FILE_BYTES,
      },
    };
  } finally {
    await handle.close();
  }
}
