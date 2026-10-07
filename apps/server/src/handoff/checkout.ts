import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../git/git.ts";
import { removeWorktree } from "../git/worktrees.ts";

/**
 * A check runs in a throwaway checkout of one commit, never in the task's own worktree. Whatever the
 * check writes (a formatter, a build's output, a generated file) lands in the copy and goes when the copy
 * does, so it is never in the task's changes and a checkpoint can never commit it. The packages the
 * worktree has installed are linked in, so the check does not install them again.
 */

export interface Checkout {
  path: string;
  /** Removes the copy. Safe to call twice. */
  release(): Promise<void>;
}

/** Folders a check finds its installed packages in. */
const INSTALLED: readonly string[] = ["node_modules", ".venv", "venv", "vendor"];
/** Folders the search for installed packages does not enter. */
const SKIP: ReadonlySet<string> = new Set([
  ...INSTALLED,
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  "coverage",
]);
const LINK_DEPTH = 3;

const isDirectory = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => undefined))?.isDirectory() === true;

/** Links the installed-package folders of `from` into the same places of `to`. */
export async function linkInstalled(from: string, to: string, depth = 0): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (INSTALLED.includes(e.name)) {
      if (await isDirectory(join(to, e.name))) continue;
      await symlink(join(from, e.name), join(to, e.name), "dir").catch(() => undefined);
    } else if (depth < LINK_DEPTH && !SKIP.has(e.name) && !e.name.startsWith(".")) {
      if (await isDirectory(join(to, e.name)))
        await linkInstalled(join(from, e.name), join(to, e.name), depth + 1);
    }
  }
}

/**
 * A detached checkout of `commit` of the project's repo, inside the task's folder (the check's runner
 * mounts it there). `installedFrom` is the task worktree whose installed packages are linked in.
 */
export async function makeCheckout(input: {
  source: string;
  folder: string;
  project: string;
  commit: string;
  installedFrom?: string | undefined;
}): Promise<Checkout> {
  const root = join(input.folder, ".check-work");
  await mkdir(root, { recursive: true });
  const path = join(root, `${input.project}-${input.commit.slice(0, 8)}-${randomUUID().slice(0, 8)}`);
  await git(input.source, ["worktree", "add", "--detach", "--force", path, input.commit]);
  let released = false;
  const checkout: Checkout = {
    path,
    release: async () => {
      if (released) return;
      released = true;
      await removeWorktree(input.source, path, true).catch(() => undefined);
    },
  };
  try {
    if (input.installedFrom !== undefined) await linkInstalled(input.installedFrom, path);
  } catch (err) {
    await checkout.release();
    throw err;
  }
  return checkout;
}
