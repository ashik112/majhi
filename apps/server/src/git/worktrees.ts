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
import { KeyedQueue } from "./keyed-queue.ts";
import { ensureWorktreeExcludes } from "./worktree-excludes.ts";

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
  /** The task the worktree is for. It is locked with that as the reason, so no prune drops its entry. */
  task?: string;
}

export interface WorktreeResult {
  createdBranch: boolean;
  /** The commit a new branch was cut from. Absent when the branch already existed. */
  startCommit?: string;
  /** The ref it was cut from (`main` or `origin/main`), as git names it. Absent with `startCommit`. */
  startRef?: string;
  /** Things the owner should know, like a fetch that failed while offline. */
  warnings: string[];
}

/** Something the owner can fix: a busy branch, a missing base, a folder in the way. */
export class WorktreeProblem extends Error {}

/** One job at a time per key, so two tasks never touch one repo's worktree list together. */
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
      console.warn(`Could not fetch ${base} from ${remote} for ${source}: ${failed}`);
      warnings.push(
        `Could not reach ${remote} to update ${base}. Working from the last copy on this machine.`,
      );
    }
    // A named branch that exists only on the remote needs its own fetch. Missing is fine.
    await tryFetch(source, remote, branch);
  }

  if (await localBranchExists(source, branch)) {
    await add(source, ["worktree", "add", path, branch], branch);
    await lockFor(req);
    await excludeCaches(path, warnings);
    return { createdBranch: false, warnings };
  }
  if (remote !== undefined && (await remoteBranchExists(source, remote, branch))) {
    await add(source, ["worktree", "add", "--track", "-b", branch, path, `${remote}/${branch}`], branch);
    await lockFor(req);
    await excludeCaches(path, warnings);
    return { createdBranch: false, warnings };
  }
  const chosen = await resolveBase(source, remote, base);
  await add(source, ["worktree", "add", "--no-track", "-b", branch, path, chosen.ref], branch);
  await lockFor(req);
  const startCommit = (await git(path, ["rev-parse", "HEAD"])).trim();
  if (chosen.diverged !== undefined) warnings.push(divergedNote(base, chosen.ref, chosen.diverged));
  await excludeCaches(path, warnings);
  return { createdBranch: true, startCommit, startRef: chosen.ref, warnings };
}

/** Not fatal: the checkpoint sets the excludes again, and its file-count limit backs it up. */
async function excludeCaches(path: string, warnings: string[]): Promise<void> {
  try {
    await ensureWorktreeExcludes([path]);
  } catch (err) {
    warnings.push(
      `Could not set up the cache excludes (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

async function lockFor(req: WorktreeRequest): Promise<void> {
  if (req.task !== undefined) await lock(req.source, req.path, lockReason(req.task));
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
    await git(source, ["fetch", "--quiet", remote, ref], {
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    return undefined;
  } catch (err) {
    return err instanceof GitError ? err.message : String(err);
  }
}

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

/** Commits each side of a base has that the other lacks. */
interface Divergence {
  /** On the local branch only. */
  ahead: number;
  /** On the remote branch only. */
  behind: number;
}

interface BaseChoice {
  ref: string;
  /** Set when local and remote each have commits the other lacks, and local was taken. */
  diverged?: Divergence;
}

/**
 * Where a new branch starts: the newer of the local base branch and its remote-tracking branch. A
 * local branch the owner merged into and did not push is ahead of its remote, and starting from the
 * remote would drop that work. Equal or remote ahead: the remote. Local ahead or diverged: local.
 * With only one of them, that one; else a tag or commit.
 */
async function resolveBase(source: string, remote: string | undefined, base: string): Promise<BaseChoice> {
  const hasRemote = remote !== undefined && (await remoteBranchExists(source, remote, base));
  const hasLocal = await localBranchExists(source, base);
  if (hasRemote && hasLocal) {
    const remoteRef = `${remote}/${base}`;
    const counts = (await git(source, ["rev-list", "--left-right", "--count", `${base}...${remoteRef}`]))
      .trim()
      .split("\t")
      .map(Number);
    const [ahead = 0, behind = 0] = counts;
    if (ahead === 0) return { ref: remoteRef };
    return behind === 0 ? { ref: base } : { ref: base, diverged: { ahead, behind } };
  }
  if (hasRemote) return { ref: `${remote}/${base}` };
  if (hasLocal) return { ref: base };
  if (await gitOk(source, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`])) return { ref: base };
  throw new WorktreeProblem(`Base branch "${base}" was not found in ${source}.`);
}

function divergedNote(base: string, local: string, d: Divergence): string {
  const plural = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  return `${base} on this machine and on the remote have diverged: ${base} has ${plural(d.ahead)} the remote does not, and the remote has ${plural(d.behind)} ${base} does not. The task started from ${local}.`;
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

export type SyncResult =
  | { status: "current"; from: string; to: string }
  | { status: "fast-forwarded" | "rebased" | "merged"; from: string; to: string }
  | { status: "refused"; reason: string };

/**
 * Brings `upstream` (a ref already fetched, like `origin/main`) into the task branch checked out in
 * `worktree`. A fast-forward when the branch has nothing of its own. Otherwise a rebase when the
 * branch was never pushed (`pushed` false: no one has the old commits), and a merge when it was, so
 * no force push is ever needed. Refused, with the branch and worktree exactly as they were, when the
 * worktree has uncommitted changes, is not on `branch`, or the change conflicts.
 */
export async function syncBranch(input: {
  worktree: string;
  branch: string;
  upstream: string;
  pushed: boolean;
  identity: { name: string; email: string };
}): Promise<SyncResult> {
  const { worktree, branch, upstream } = input;
  const who = ["-c", `user.name=${input.identity.name}`, "-c", `user.email=${input.identity.email}`];
  return queue.run(worktree, async (): Promise<SyncResult> => {
    const current = (await git(worktree, ["symbolic-ref", "--short", "HEAD"]).catch(() => "")).trim();
    if (current !== branch) return { status: "refused", reason: `the worktree is not on ${branch}` };
    const dirty = await uncommitted(worktree);
    if (dirty.length > 0) return { status: "refused", reason: "it has uncommitted changes" };
    const tip = (await git(worktree, ["rev-parse", `${upstream}^{commit}`])).trim();
    const head = (await git(worktree, ["rev-parse", "HEAD"])).trim();
    if (head === tip || (await gitOk(worktree, ["merge-base", "--is-ancestor", tip, head]))) {
      return { status: "current", from: head, to: head };
    }
    const done = async (status: "fast-forwarded" | "rebased" | "merged"): Promise<SyncResult> => ({
      status,
      from: head,
      to: (await git(worktree, ["rev-parse", "HEAD"])).trim(),
    });
    if (await gitOk(worktree, ["merge-base", "--is-ancestor", head, tip])) {
      await git(worktree, ["merge", "--ff-only", "--quiet", tip]);
      return done("fast-forwarded");
    }
    const action = input.pushed ? "merge" : "rebase";
    try {
      if (input.pushed) {
        await git(worktree, [
          ...who,
          "merge",
          "--no-ff",
          "--no-verify",
          "--quiet",
          "-m",
          `Merge ${upstream} into ${branch}`,
          tip,
        ]);
      } else {
        await git(worktree, [...who, "rebase", "--quiet", tip]);
      }
      return done(input.pushed ? "merged" : "rebased");
    } catch (err) {
      const files = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
      await git(worktree, [action, "--abort"]).catch(() => undefined);
      if (files.length === 0) throw err;
      return {
        status: "refused",
        reason: `${upstream} conflicts with this branch in ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}. Nothing was changed`,
      };
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
        const missing = await stat(path).then(
          () => false,
          (err: unknown) => errorCode(err) === "ENOENT",
        );
        return {
          path,
          changes: missing ? [] : ["Could not inspect this worktree safely"],
        };
      }
    }),
  );
  return found.filter((f) => f.changes.length > 0);
}

/**
 * Removes a worktree from its source repo and deletes its folder. Without `force`
 * git refuses when there are uncommitted changes. The branch stays. A locked worktree is unlocked
 * first, and locked again with its old reason when git refuses to remove it.
 */
export function removeWorktree(source: string, path: string, force: boolean): Promise<void> {
  return queue.run(source, async () => {
    if (await isGitRepo(source)) {
      const own = await entryFor(source, path).catch(() => undefined);
      const reason =
        own === undefined ? undefined : await readFile(join(own, "locked"), "utf8").catch(() => undefined);
      // `git worktree remove` deletes the folder inside a 30 second git call, which a checkout with
      // node_modules or build output does not finish. majhi checks for uncommitted work itself,
      // deletes the folder with no time limit, then drops the entry.
      if (!force) {
        const changes = await uncommitted(path).catch(async (err: unknown) => {
          const missing = await stat(path).then(
            () => false,
            () => true,
          );
          // A folder that is gone has nothing to lose; one we cannot inspect is never deleted.
          if (missing) return [];
          throw new WorktreeProblem(
            `Could not inspect ${path} safely: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        if (changes.length > 0) {
          throw new WorktreeProblem(`Uncommitted changes in ${path}: ${changes.slice(0, 3).join(", ")}`);
        }
      }
      if (reason !== undefined) await git(source, ["worktree", "unlock", path]).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
      // Only this worktree's own entry. A `git worktree prune` would also drop the entry of a live
      // task whose folder is out of reach for a moment, and its checkout stops being a git repo.
      if (own !== undefined) await rm(own, { recursive: true, force: true });
    }
    await rm(path, { recursive: true, force: true });
  });
}

/** What a task worktree's lock says. */
export function lockReason(task: string): string {
  return `majhi task ${task}`;
}

/**
 * Locks a task worktree, so no `git worktree prune` drops its entry while its folder is out of
 * sight of whoever runs it (the owner's checkout, a container, a host helper). Already locked is fine.
 */
export function lockWorktree(source: string, path: string, task: string): Promise<void> {
  return queue.run(source, () => lock(source, path, lockReason(task)));
}

async function lock(source: string, path: string, reason: string): Promise<void> {
  try {
    await git(source, ["worktree", "lock", ...(reason === "" ? [] : ["--reason", reason]), path]);
  } catch (err) {
    if (err instanceof GitError && /already locked/.test(err.stderr)) return;
    throw err;
  }
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
      return {
        status: "skipped",
        reason: `its .git file points outside ${source}`,
      };
    if (!(await localBranchExists(source, branch)))
      return { status: "skipped", reason: `its branch ${branch} is missing` };
    const elsewhere = await checkedOutAt(source, branch);
    if (elsewhere !== undefined && !(await samePath(elsewhere, path)))
      return {
        status: "skipped",
        reason: `its branch ${branch} is checked out at ${elsewhere}`,
      };

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

/** Same folder: the same path, or the same inode once symlinks are followed. */
export async function samePath(a: string, b: string): Promise<boolean> {
  if (resolve(a) === resolve(b)) return true;
  return sameDir(a, b).catch(() => false);
}
