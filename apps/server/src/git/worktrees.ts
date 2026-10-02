import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { errorCode } from "../errors.ts";
import {
  FETCH_TIMEOUT_MS,
  GitError,
  git,
  gitOk,
  isGitRepo,
  localBranchExists,
  remoteBranchExists,
  remoteOf,
  uncommitted,
} from "./git.ts";

export interface WorktreeRequest {
  /** The project's own checkout. */
  source: string;
  base: string;
  branch: string;
  /** Where the worktree goes. Must not exist, or be empty. */
  path: string;
  /**
   * The base is a local branch of this checkout (another task's working branch, 5.4a): no fetch,
   * and the new branch starts at its local tip.
   */
  localBase?: boolean;
  /**
   * Called once when a fetch fails for lack of SSH access. Asks the host helper to load the
   * owner's keys again; resolves true when that was possible, and the fetch is then retried.
   */
  reloadKeys?: () => Promise<boolean>;
}

export interface WorktreeResult {
  createdBranch: boolean;
  /** The commit a new branch was cut from. Absent when the branch already existed. */
  startCommit?: string;
  /** Things the owner should know, like a fetch that failed while offline. */
  warnings: string[];
}

/** Something the owner can fix: a busy branch, a missing base, a folder in the way. */
export class WorktreeProblem extends Error {}

/** Runs one job at a time per key, so two tasks never touch one repo's worktree list together. */
class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve();
    const next = tail.then(job, job);
    const settled = next.catch(() => undefined);
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return next;
  }
}

const queue = new KeyedQueue();

/**
 * Adds one worktree for a task: fetches the base (skipped without a remote, and not fatal
 * when offline), then makes a new branch from it, or checks out the named branch when it
 * already exists locally or on the remote. Never pushes.
 */
export function createWorktree(req: WorktreeRequest): Promise<WorktreeResult> {
  return queue.run(req.source, () => create(req));
}

async function create(req: WorktreeRequest): Promise<WorktreeResult> {
  const { source, base, branch, path } = req;
  if (!(await isGitRepo(source)))
    throw new WorktreeProblem(`${source} is not a git repo the server can see.`);

  if (await isWorktreeOf(path, branch)) return { createdBranch: false, warnings: [] };
  await requireFreePath(path);

  const warnings: string[] = [];
  const remote = req.localBase === true ? undefined : await remoteOf(source);
  if (remote !== undefined) {
    const failed = await fetchWithKeys(source, remote, base, req.reloadKeys);
    if (failed !== undefined) {
      warnings.push(
        `Could not fetch ${base} from ${remote} (${failed}). Using the last copy on this machine.`,
      );
    }
    // A named branch that exists only on the remote needs its own fetch. Missing is fine.
    await tryFetch(source, remote, branch);
  }

  if (await localBranchExists(source, branch)) {
    await add(source, ["worktree", "add", path, branch], branch);
    return { createdBranch: false, warnings };
  }
  if (remote !== undefined && (await remoteBranchExists(source, remote, branch))) {
    await add(source, ["worktree", "add", "--track", "-b", branch, path, `${remote}/${branch}`], branch);
    return { createdBranch: false, warnings };
  }
  const baseRef = await resolveBase(source, remote, base);
  await add(source, ["worktree", "add", "--no-track", "-b", branch, path, baseRef], branch);
  const startCommit = (await git(path, ["rev-parse", "HEAD"])).trim();
  return { createdBranch: true, startCommit, warnings };
}

/** ssh's way of saying no key it had was accepted, or the host could not be verified. */
const SSH_AUTH_FAILURE =
  /Permission denied \(publickey|Host key verification failed|no such identity|Too many authentication failures/i;

export function isSshAuthFailure(message: string): boolean {
  return SSH_AUTH_FAILURE.test(message);
}

/** Fetches; after an SSH access failure, reloads the owner's keys once and tries again. */
async function fetchWithKeys(
  source: string,
  remote: string,
  ref: string,
  reloadKeys: (() => Promise<boolean>) | undefined,
): Promise<string | undefined> {
  const failed = await tryFetch(source, remote, ref);
  if (failed === undefined || reloadKeys === undefined || !isSshAuthFailure(failed)) return failed;
  if (!(await reloadKeys().catch(() => false))) return failed;
  return tryFetch(source, remote, ref);
}

async function tryFetch(source: string, remote: string, ref: string): Promise<string | undefined> {
  try {
    await git(source, ["fetch", "--quiet", remote, ref], { timeoutMs: FETCH_TIMEOUT_MS });
    return undefined;
  } catch (err) {
    return err instanceof GitError ? err.message : String(err);
  }
}

/** The remote copy of the base when there is one, else the local branch, tag or commit. */
/**
 * Whether a task could start from `base` in `source`: a remote or local branch, or a commit,
 * as this machine knows them now. No fetch, so it is fast enough to run on create.
 */
export async function baseExists(source: string, base: string): Promise<boolean> {
  const remote = await remoteOf(source).catch(() => undefined);
  return resolveBase(source, remote, base).then(
    () => true,
    (err: unknown) => {
      if (err instanceof WorktreeProblem) return false;
      throw err;
    },
  );
}

async function resolveBase(source: string, remote: string | undefined, base: string): Promise<string> {
  if (remote !== undefined && (await remoteBranchExists(source, remote, base))) return `${remote}/${base}`;
  if (await localBranchExists(source, base)) return base;
  if (await gitOk(source, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`])) return base;
  throw new WorktreeProblem(`Base branch "${base}" was not found in ${source}.`);
}

async function add(source: string, args: string[], branch: string): Promise<void> {
  try {
    await git(source, args);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    const busy = /already (?:checked out|used by worktree) at '([^']+)'/.exec(err.stderr);
    if (busy?.[1] !== undefined) {
      const dirty = await uncommitted(busy[1]).then(
        (lines) => lines.length > 0,
        () => false,
      );
      throw new WorktreeProblem(
        `Branch "${branch}" is already checked out at ${busy[1]}${dirty ? ", which has uncommitted changes" : ""}. ` +
          "Switch that checkout to another branch, or name a different working branch.",
      );
    }
    throw new WorktreeProblem(`Could not add the worktree for "${branch}": ${err.message}`);
  }
}

async function requireFreePath(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory() || (await readdir(path)).length > 0) {
      throw new WorktreeProblem(`${path} already exists. Remove it or pick another task.`);
    }
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
  }
}

/** True when `path` is already this branch's worktree, so starting twice does nothing. */
async function isWorktreeOf(path: string, branch: string): Promise<boolean> {
  try {
    const current = (await git(path, ["symbolic-ref", "--short", "HEAD"])).trim();
    const top = (await git(path, ["rev-parse", "--show-toplevel"])).trim();
    return current === branch && (await sameDir(top, path));
  } catch {
    return false;
  }
}

async function sameDir(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([stat(a), stat(b)]);
  return x.ino === y.ino && x.dev === y.dev;
}

export type RestackResult =
  | { status: "rebased"; commit: string }
  | { status: "current" }
  | { status: "skipped"; reason: string }
  | { status: "conflict"; files: string[] };

/**
 * Moves a stacked branch onto the new tip of the branch it builds on (5.4a): `git rebase --onto
 * <new tip> <old base> <branch>` in the worktree. Skipped when the worktree has uncommitted
 * changes. On a conflict the rebase is aborted, so the worktree is left as it was.
 */
export async function restack(input: {
  worktree: string;
  branch: string;
  /** The branch it is stacked on, and the commit of it the branch sits on now. */
  onto: string;
  from: string;
  /** Who the rebased commits are committed by. */
  identity: { name: string; email: string };
}): Promise<RestackResult> {
  const { worktree, branch, onto, from } = input;
  const who = ["-c", `user.name=${input.identity.name}`, "-c", `user.email=${input.identity.email}`];
  return queue.run(worktree, async () => {
    const tip = (await git(worktree, ["rev-parse", `${onto}^{commit}`])).trim();
    if (tip === from) return { status: "current" };
    const dirty = await uncommitted(worktree);
    if (dirty.length > 0) return { status: "skipped", reason: "it has uncommitted changes" };
    try {
      await git(worktree, [...who, "rebase", "--quiet", "--onto", tip, from, branch]);
      return { status: "rebased", commit: tip };
    } catch (err) {
      const files = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
      await git(worktree, ["rebase", "--abort"]).catch(() => undefined);
      if (files.length === 0) throw err;
      return { status: "conflict", files };
    }
  });
}

/** Worktrees with uncommitted changes, from the paths given. Missing folders count as clean. */
export async function dirtyWorktrees(
  paths: readonly string[],
): Promise<{ path: string; changes: string[] }[]> {
  const found = await Promise.all(
    paths.map(async (path) => {
      try {
        return { path, changes: await uncommitted(path) };
      } catch {
        return { path, changes: [] };
      }
    }),
  );
  return found.filter((f) => f.changes.length > 0);
}

/**
 * Removes a worktree from its source repo and deletes its folder. Without `force`
 * git refuses when there are uncommitted changes. The branch stays.
 */
export function removeWorktree(source: string, path: string, force: boolean): Promise<void> {
  return queue.run(source, async () => {
    if (await isGitRepo(source)) {
      const args = ["worktree", "remove", ...(force ? ["--force"] : []), path];
      try {
        await git(source, args);
      } catch (err) {
        const missing = await stat(path).then(
          () => false,
          () => true,
        );
        if (!missing && !force) throw new WorktreeProblem(err instanceof Error ? err.message : String(err));
      }
      // Only this worktree's own entry. A `git worktree prune` would also drop the entry of a live
      // task whose folder is out of reach for a moment, and its checkout stops being a git repo.
      const own = await entryFor(source, path).catch(() => undefined);
      if (own !== undefined) await rm(own, { recursive: true, force: true });
    }
    await rm(path, { recursive: true, force: true });
  });
}

export type RepairResult =
  | { status: "fine" }
  | { status: "repaired"; entry: string }
  | { status: "skipped"; reason: string };

/**
 * Gives a task worktree back its entry in the source repo's `.git/worktrees` when that entry is
 * gone (or now belongs to another checkout) while the folder and its branch are fine. Every git
 * command in the folder fails until then. The entry is written as `git worktree add` writes it and
 * the index is rebuilt from the branch tip, so the files and uncommitted changes stay as they are.
 */
export function repairWorktree(source: string, path: string, branch: string): Promise<RepairResult> {
  return queue.run(source, async () => {
    const link = await readGitLink(path);
    if (link === undefined) return { status: "fine" };
    if (await pointsBack(link, path)) return { status: "fine" };
    if (!(await isGitRepo(source))) return { status: "skipped", reason: `${source} is not a git repo` };
    const entries = join(await commonDir(source), "worktrees");
    if (!(await samePath(dirname(link), entries)))
      return { status: "skipped", reason: `its .git file points outside ${source}` };
    if (!(await localBranchExists(source, branch)))
      return { status: "skipped", reason: `its branch ${branch} is missing` };
    const elsewhere = await checkedOutAt(source, branch);
    if (elsewhere !== undefined && !(await samePath(elsewhere, path)))
      return { status: "skipped", reason: `its branch ${branch} is checked out at ${elsewhere}` };

    // The old name when it is free, so the folder's `.git` file stays as it was.
    const entry = await freeEntry(entries, basename(link));
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, "gitdir"), `${join(resolve(path), ".git")}\n`);
    await writeFile(join(entry, "commondir"), "../..\n");
    await writeFile(join(entry, "HEAD"), `ref: refs/heads/${branch}\n`);
    if (entry !== link) await writeFile(join(path, ".git"), `gitdir: ${entry}\n`);
    await git(path, ["reset", "--quiet"]);
    return { status: "repaired", entry };
  });
}

/** Where the worktree's `.git` file points, absolute. Undefined when there is no such file. */
async function readGitLink(path: string): Promise<string | undefined> {
  const text = await readFile(join(path, ".git"), "utf8").catch(() => undefined);
  const target = /^gitdir: (.+)$/m.exec(text ?? "")?.[1]?.trim();
  if (target === undefined || target === "") return undefined;
  return isAbsolute(target) ? target : resolve(path, target);
}

/** True when the entry exists and records `path` as its worktree. */
async function pointsBack(entry: string, path: string): Promise<boolean> {
  const recorded = await readFile(join(entry, "gitdir"), "utf8").catch(() => undefined);
  return recorded !== undefined && (await samePath(dirname(recorded.trim()), path));
}

/** The entry in the source repo's `.git/worktrees` whose worktree is `path`. */
async function entryFor(source: string, path: string): Promise<string | undefined> {
  const entries = join(await commonDir(source), "worktrees");
  const names = await readdir(entries).catch(() => [] as string[]);
  for (const name of names) {
    if (await pointsBack(join(entries, name), path)) return join(entries, name);
  }
  return undefined;
}

async function commonDir(source: string): Promise<string> {
  return (await git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
}

/** The worktree (or main checkout) that has `branch` checked out, if any. */
async function checkedOutAt(source: string, branch: string): Promise<string | undefined> {
  let current: string | undefined;
  for (const line of (await git(source, ["worktree", "list", "--porcelain"])).split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return current;
  }
  return undefined;
}

async function freeEntry(entries: string, name: string): Promise<string> {
  for (let n = 0; ; n++) {
    const entry = join(entries, n === 0 ? name : `${name}${n}`);
    if (
      !(await stat(entry).then(
        () => true,
        () => false,
      ))
    )
      return entry;
  }
}

async function samePath(a: string, b: string): Promise<boolean> {
  if (resolve(a) === resolve(b)) return true;
  return sameDir(a, b).catch(() => false);
}
