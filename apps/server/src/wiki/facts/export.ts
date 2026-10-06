import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type CommitSha, CommitShaSchema } from "@majhi/shared";
import { git } from "../../git/git.ts";

const run = promisify(execFile);

const EXPORT_PREFIX = "src-";
/** Writing a big repo's tar and unpacking it. */
const EXPORT_TIMEOUT_MS = 5 * 60_000;

/** Where the clean export of a commit lives: `<cache folder>/src-<sha>`. The sha is parsed, so it is one path segment. */
export function exportDirOf(cacheDir: string, sha: CommitSha): string {
  return join(cacheDir, `${EXPORT_PREFIX}${CommitShaSchema.parse(sha)}`);
}

/**
 * Writes `git archive <sha>` of a repo into `<cache folder>/src-<sha>/` and returns that folder. Only what git
 * tracks at that commit is in it, so an agent's worktrees inside the checkout, build output and untracked files never
 * reach the readers (phase 0 measured 34 of 42 routes as worktree copies). The export is the only source the wiki's
 * readers see: the sealed reader mounts it read-only, and the scanners refuse any path that leaves it.
 *
 * Idempotent: a folder that exists is a finished export (it is unpacked beside it and renamed into place), so a
 * second call for the same commit does nothing, and a crash leaves no half-written `src-<sha>`.
 */
export async function exportCommit(input: {
  /** The project's checkout (or any repo that has the commit). */
  repoPath: string;
  cacheDir: string;
  sha: CommitSha;
}): Promise<string> {
  const target = exportDirOf(input.cacheDir, input.sha);
  if (await exists(target)) return target;
  await mkdir(input.cacheDir, { recursive: true, mode: 0o700 });
  const work = `${target}.partial-${process.pid}`;
  const tar = `${work}.tar`;
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true, mode: 0o700 });
  try {
    await git(input.repoPath, ["archive", "--format=tar", "-o", tar, input.sha], {
      timeoutMs: EXPORT_TIMEOUT_MS,
    });
    // tar leaves a symlink as a symlink and refuses a member outside the folder; the readers refuse a link out of the export.
    await run("tar", ["-xf", tar, "-C", work, "--no-same-owner"], { timeout: EXPORT_TIMEOUT_MS });
    await rename(work, target).catch(async (err: unknown) => {
      // Another run finished the same export first: keep theirs.
      if (!(await exists(target))) throw err;
    });
  } finally {
    await rm(tar, { force: true });
    await rm(work, { recursive: true, force: true });
  }
  return target;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

/** Removes exports of other commits, keeping the ones named. The cache folder stays small: one export per commit in use. */
export async function pruneExports(cacheDir: string, keep: readonly CommitSha[]): Promise<void> {
  const wanted = new Set(keep.map((sha) => `${EXPORT_PREFIX}${sha}`));
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(EXPORT_PREFIX) && !wanted.has(name)) {
      await rm(join(cacheDir, name), { recursive: true, force: true });
    }
  }
}
