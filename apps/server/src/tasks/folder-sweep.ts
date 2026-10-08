import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { Task } from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import { git, gitOk, uncommitted } from "../git/git.ts";
import { removeWorktree } from "../git/worktrees.ts";
import type { Store } from "../store/index.ts";

/**
 * Frees disk in the folders of tasks that are done (SPEC 5.4, 5.18 Cleanup). Code only, no model.
 *
 * What it deletes is what a task can rebuild: dependency folders and build output. It never
 * deletes a tracked file, never follows a symlink, and leaves a task alone when any of its repos has
 * a change to a tracked file or when the task is no longer done by the time it gets to it. Optionally
 * it also removes the whole worktree of a task done for a while, through the same path the cleanup
 * uses, when the worktree is clean and its commits are kept elsewhere.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Rebuildable wherever they are, as long as no tracked file is in them. */
export const REBUILDABLE = [
  "node_modules",
  ".pnpm-store",
  ".turbo",
  ".next",
  ".vite",
  "test-results",
  "playwright-report",
  ".venv",
] as const;

/** Names that are often source too: only removed when git ignores them. */
export const REBUILDABLE_IF_IGNORED = ["dist", "build", "target"] as const;

/** What an idle task in review or paused gives up: the dependencies only. Build output may be what the owner is looking at. */
const IDLE_REBUILDABLE: readonly string[] = ["node_modules", ".pnpm-store"];

/** Left in the task folder when dependencies were removed; the next turn of an agent reads and deletes it. */
export const DEPS_DROPPED_FILE = ".majhi-deps-dropped";

/** Folders of a task that are never searched. */
const SKIPPED = new Set([".git", "attachments"]);
/** How deep under a task folder a rebuildable folder is looked for (task/repo/packages/x/node_modules is 4). */
const MAX_DEPTH = 7;

/** Done tasks give up everything rebuildable; idle ones in review or paused only their dependencies. */
export type Mode = "done" | "idle";

export interface SweepDeps {
  store: Store;
  /** The folder that holds every task folder. */
  tasksDir: () => Promise<string>;
  now?: () => Date;
}

export interface SweepOptions {
  /** A task done for fewer hours than this is left alone. */
  hours: number;
  /** Also remove the worktrees of tasks done for this many days. 0 is off. */
  worktreeDays: number;
  /** Also remove node_modules of tasks in review or paused with no change for this many days. Absent or 0 is off. */
  idleDays?: number | undefined;
  /** Only tasks of this workspace. Absent: every workspace. */
  org?: string | undefined;
}

export interface SweepTask {
  id: string;
  /** `done`: a done task, `idle`: one in review or paused. */
  mode: Mode;
  /** Bytes that deleting frees (hard links shared with a store are not counted). */
  bytes: number;
  /** Folders removed, relative to the task folder. */
  removed: string[];
  /** Worktrees removed whole. */
  worktrees: string[];
  /** Why the task or part of it was left alone. */
  kept: string[];
}

export interface SweepReport {
  freedBytes: number;
  tasks: SweepTask[];
}

/** One task's candidates before anything is deleted. */
interface Plan {
  task: Task;
  /** Real path of the task folder. */
  root: string;
  doneAt: string;
  mode: Mode;
  /** Rebuildable folders, as paths under `root`. */
  folders: string[];
  /** Worktrees that can go whole. */
  trees: Task["repos"];
  kept: string[];
}

const run = promisify(execFile);

/** How long a tree's measured size is reused: worktrees hold hundreds of thousands of files. */
const TREE_CACHE_MS = 30 * 60_000;
const treeCache = new Map<string, { at: number; bytes: number }>();

/** Forgets every cached tree size: a sweep just deleted files. */
export function forgetTreeSizes(): void {
  treeCache.clear();
}

/**
 * Size on disk of a tree, without following symlinks. `total` counts hard-linked files once;
 * `freeable` leaves them out (deleting the tree would not free them). Measured by the system's `du`
 * and `find` in a child process on Linux (the server's container), so a walk of a large worktree never
 * holds the server's event loop; elsewhere, or when they fail, by walking it here. Reused for 30 minutes.
 */
export async function treeBytes(path: string, mode: "freeable" | "total" = "freeable"): Promise<number> {
  const key = `${mode}:${path}`;
  const hit = treeCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < TREE_CACHE_MS) return hit.bytes;
  const bytes =
    (process.platform === "linux" ? await systemBytes(path, mode) : undefined) ??
    (await walkBytes(path, mode));
  treeCache.set(key, { at: Date.now(), bytes });
  return bytes;
}

/** GNU `du` (hard links once) or `find` (single-link files and folders only), summed by the child. */
async function systemBytes(path: string, mode: "freeable" | "total"): Promise<number | undefined> {
  const script =
    mode === "total"
      ? "du -sk --one-file-system -- \"$1\" 2>/dev/null | awk '{print $1 * 1024}'"
      : 'find "$1" -xdev \\( -type d -o \\( -type f -links 1 \\) \\) -printf "%b\\n" 2>/dev/null | awk \'{s += $1} END {print s * 512}\'';
  try {
    const { stdout } = await run("sh", ["-c", script, "sh", path], {
      maxBuffer: 1 << 20,
      timeout: 10 * 60_000,
    });
    const n = Number(stdout.trim());
    return Number.isFinite(n) && stdout.trim() !== "" ? n : undefined;
  } catch {
    return undefined;
  }
}

/** The walk in this process: used off Linux and as the fallback. */
async function walkBytes(path: string, mode: "freeable" | "total"): Promise<number> {
  const seen = new Set<string>();
  let total = 0;
  const walk = async (p: string): Promise<void> => {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(p);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      total += info.blocks * 512;
      let names: string[];
      try {
        names = await readdir(p);
      } catch {
        return;
      }
      for (let i = 0; i < names.length; i += 64) {
        await Promise.all(names.slice(i, i + 64).map((n) => walk(join(p, n))));
      }
      return;
    }
    if (info.nlink > 1) {
      if (mode === "freeable") return;
      const key = `${info.dev}:${info.ino}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    total += info.blocks * 512;
  };
  await walk(path);
  return total;
}

/** `1.2 GB`, `340 MB`: decimal units, as the disk reports them. */
export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export interface Measure {
  rootBytes: number;
  rebuildableBytes: number;
  tasks: number;
}

/** The size of the task folders is asked at most this often: walking them is not free. */
const MEASURE_EVERY_MS = 30 * 60_000;

export class TaskFolderSweep {
  private running = false;
  private last: { at: number; value: Measure } | undefined;
  private measuring: Promise<void> | undefined;

  constructor(private readonly deps: SweepDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** What a sweep would free now, without deleting anything. */
  async preview(options: SweepOptions): Promise<SweepReport> {
    return this.go(options, true);
  }

  /** Deletes what is safe to delete. A second call right after frees nothing. */
  async run(options: SweepOptions): Promise<SweepReport> {
    if (this.running) throw new UserError("Folders are being cleaned already.", 409);
    this.running = true;
    try {
      return await this.go(options, false);
    } finally {
      this.forget();
      this.running = false;
    }
  }

  /**
   * The last measurement, for Health, which reads often. A stale or missing one starts a new
   * measurement in the background; undefined until the first finishes.
   */
  snapshot(): Measure | undefined {
    const stale = this.last === undefined || this.now().getTime() - this.last.at > MEASURE_EVERY_MS;
    if (stale && this.measuring === undefined) {
      this.measuring = this.measure().then(
        (value) => {
          this.last = { at: this.now().getTime(), value };
          this.measuring = undefined;
        },
        () => {
          this.measuring = undefined;
        },
      );
    }
    return this.last?.value;
  }

  /** Forgets the last measurement: a sweep just changed the folders. */
  forget(): void {
    this.last = undefined;
    forgetTreeSizes();
  }

  /** The size of the task folders and, within done tasks, of what a sweep could free. */
  async measure(): Promise<Measure> {
    const root = await this.deps.tasksDir();
    const rootBytes = await treeBytes(root, "total").catch(() => 0);
    const report = await this.go({ hours: 0, worktreeDays: 0 }, true);
    return {
      rootBytes,
      rebuildableBytes: report.freedBytes,
      tasks: report.tasks.filter((t) => t.bytes > 0).length,
    };
  }

  private async go(options: SweepOptions, dry: boolean): Promise<SweepReport> {
    const report: SweepReport = { freedBytes: 0, tasks: [] };
    const tasksRoot = await realpath(await this.deps.tasksDir()).catch(() => undefined);
    if (tasksRoot === undefined) return report;
    const cutoff = new Date(this.now().getTime() - options.hours * HOUR_MS).toISOString();
    const treeCutoff = new Date(this.now().getTime() - options.worktreeDays * DAY_MS).toISOString();
    for (const { id, doneAt } of this.deps.store.tasks.doneBefore(cutoff)) {
      const task = this.deps.store.tasks.get(id);
      if (task === undefined) continue;
      if (options.org !== undefined && (task.org ?? "private") !== options.org) continue;
      const wholeTrees = options.worktreeDays > 0 && doneAt < treeCutoff;
      const result = await this.sweepTask(task, doneAt, tasksRoot, "done", wholeTrees, dry);
      if (result.bytes > 0 || result.kept.length > 0) report.tasks.push(result);
      report.freedBytes += result.bytes;
    }
    const idleDays = options.idleDays ?? 0;
    if (idleDays > 0) {
      const idleCutoff = new Date(this.now().getTime() - idleDays * DAY_MS).toISOString();
      for (const { id, at } of this.deps.store.tasks.idleBefore(idleCutoff)) {
        const task = this.deps.store.tasks.get(id);
        if (task === undefined) continue;
        if (options.org !== undefined && (task.org ?? "private") !== options.org) continue;
        const result = await this.sweepTask(task, at, tasksRoot, "idle", false, dry);
        if (result.bytes > 0 || result.kept.length > 0) report.tasks.push(result);
        report.freedBytes += result.bytes;
      }
    }
    return report;
  }

  /** True while the task is still in the state it was chosen in (done, or review or paused) and unchanged since. */
  private stillSo(id: string, at: string, mode: Mode): boolean {
    const now = this.deps.store.tasks.get(id);
    if (now === undefined || now.updatedAt !== at) return false;
    return mode === "done" ? now.status === "done" : now.status === "review" || now.status === "paused";
  }

  private async sweepTask(
    task: Task,
    doneAt: string,
    tasksRoot: string,
    mode: Mode,
    wholeTrees: boolean,
    dry: boolean,
  ): Promise<SweepTask> {
    const out: SweepTask = { id: task.id, mode, bytes: 0, removed: [], worktrees: [], kept: [] };
    const plan = await this.plan(task, doneAt, tasksRoot, mode, wholeTrees);
    out.kept.push(...plan.kept);
    if (plan.folders.length === 0 && plan.trees.length === 0) return out;

    // Whole worktrees first: what is inside one then needs no separate delete.
    const gone: string[] = [];
    for (const repo of plan.trees) {
      const worktree = repo.worktree;
      if (worktree === undefined) continue;
      if (!this.stillSo(task.id, doneAt, mode)) {
        out.kept.push(mode === "done" ? "it was reopened" : "it changed");
        return out;
      }
      const bytes = await treeBytes(worktree);
      if (!dry) {
        try {
          await removeWorktree(repo.source, worktree, false);
          this.deps.store.tasks.clearWorktree(task.id, repo.project);
        } catch (err) {
          out.kept.push(`worktree ${repo.project} stays: ${errorMessage(err)}`);
          continue;
        }
      }
      gone.push(worktree);
      out.worktrees.push(repo.project);
      out.bytes += bytes;
    }

    for (const folder of plan.folders) {
      if (gone.some((g) => folder === g || inside(folder, g))) continue;
      if (!this.stillSo(task.id, doneAt, mode)) {
        out.kept.push(mode === "done" ? "it was reopened" : "it changed");
        return out;
      }
      // Right before deleting: the path is still a real folder inside the task folder, not a link.
      const real = await realpath(folder).catch(() => undefined);
      const info = await lstat(folder).catch(() => undefined);
      if (real !== folder || info === undefined || !info.isDirectory() || !inside(real, plan.root)) continue;
      const bytes = await treeBytes(folder);
      if (!dry) {
        try {
          await rm(folder, { recursive: true, force: true });
        } catch (err) {
          out.kept.push(`${relative(plan.root, folder)} stays: ${errorMessage(err)}`);
          continue;
        }
      }
      out.removed.push(relative(plan.root, folder));
      out.bytes += bytes;
    }
    if (!dry && mode === "idle" && out.removed.length > 0) {
      await writeFile(join(plan.root, DEPS_DROPPED_FILE), `${out.removed.join("\n")}\n`).catch(
        () => undefined,
      );
    }
    return out;
  }

  /** Decides what may go from this task, from a fresh look at its folder and repos. */
  private async plan(
    task: Task,
    doneAt: string,
    tasksRoot: string,
    mode: Mode,
    wholeTrees: boolean,
  ): Promise<Plan> {
    const plan: Plan = { task, root: task.folder, doneAt, mode, folders: [], trees: [], kept: [] };
    const root = await realpath(task.folder).catch(() => undefined);
    if (root === undefined) return plan;
    if (!inside(root, tasksRoot)) {
      plan.kept.push("its folder is outside the tasks folder");
      return plan;
    }
    plan.root = root;

    // A change to a tracked file in any repo of the task keeps the whole task: it may still be wanted.
    for (const repo of task.repos) {
      if (repo.worktree === undefined) continue;
      const exists = await stat(repo.worktree).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (!exists) continue;
      if (await trackedChanges(repo.worktree)) {
        plan.kept.push(`${repo.project} has uncommitted changes`);
        return plan;
      }
    }

    if (wholeTrees) {
      for (const repo of task.repos) {
        const worktree = repo.worktree;
        if (worktree === undefined) continue;
        const real = await realpath(worktree).catch(() => undefined);
        if (real === undefined || !inside(real, root)) continue;
        const why = await worktreeKept(repo.source, worktree, repo.branch, repo.base);
        if (why === undefined) plan.trees.push(repo);
        else plan.kept.push(`worktree ${repo.project}: ${why}`);
      }
    }

    const verdicts = new Map<string, boolean>();
    await this.find(root, root, 0, verdicts, plan);
    return plan;
  }

  /** Walks down from `dir`, never into a symlink, `.git`, attachments or a folder it already picked. */
  private async find(
    root: string,
    dir: string,
    depth: number,
    repoClean: Map<string, boolean>,
    plan: Plan,
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (SKIPPED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      const names = plan.mode === "idle" ? IDLE_REBUILDABLE : (REBUILDABLE as readonly string[]);
      const always = names.includes(entry.name);
      const ignoredOnly =
        plan.mode === "done" && (REBUILDABLE_IF_IGNORED as readonly string[]).includes(entry.name);
      if (!always && !ignoredOnly) {
        await this.find(root, path, depth + 1, repoClean, plan);
        continue;
      }
      const why = await this.refuse(root, path, ignoredOnly, repoClean);
      if (why === undefined) plan.folders.push(path);
      else if (why !== "") plan.kept.push(`${relative(root, path)}: ${why}`);
    }
  }

  /** Why `path` must stay, "" to stay silently, or undefined when it may go. */
  private async refuse(
    root: string,
    path: string,
    needsIgnore: boolean,
    repoClean: Map<string, boolean>,
  ): Promise<string | undefined> {
    const repo = await repoOf(root, dirname(path));
    if (repo === undefined) return needsIgnore ? "" : undefined;
    let clean = repoClean.get(repo);
    if (clean === undefined) {
      clean = !(await trackedChanges(repo));
      repoClean.set(repo, clean);
    }
    if (!clean) return "its repo has uncommitted changes";
    const rel = relative(repo, path);
    // A tracked file anywhere inside, or git failing to say: leave it.
    let tracked: string;
    try {
      tracked = await git(repo, ["ls-files", "-z", "--", rel]);
    } catch {
      return "git could not say if it holds tracked files";
    }
    if (tracked !== "") return "it holds tracked files";
    if (needsIgnore && !(await gitOk(repo, ["check-ignore", "-q", "--", `${rel}/`]))) return "";
    return undefined;
  }
}

/** The nearest folder at or above `from`, inside `root`, that is a git checkout. */
async function repoOf(root: string, from: string): Promise<string | undefined> {
  let dir = from;
  while (dir === root || inside(dir, root)) {
    if (
      await lstat(join(dir, ".git")).then(
        () => true,
        () => false,
      )
    )
      return dir;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
  return undefined;
}

/** True when a tracked file is modified or staged, or git cannot tell. Untracked files do not count. */
async function trackedChanges(repo: string): Promise<boolean> {
  try {
    const out = await git(repo, ["status", "--porcelain", "--untracked-files=no"]);
    return out.trim() !== "";
  } catch {
    return true;
  }
}

/**
 * Why a worktree must stay, or undefined when it can go whole: it is clean, even of untracked files,
 * and its branch tip is in the base or in a remote branch. The branch itself stays either way.
 */
async function worktreeKept(
  source: string,
  worktree: string,
  branch: string,
  base: string,
): Promise<string | undefined> {
  try {
    if ((await uncommitted(worktree)).length > 0) return "it has uncommitted changes";
    const tip = (await git(worktree, ["rev-parse", "--verify", "HEAD"])).trim();
    if (await gitOk(source, ["merge-base", "--is-ancestor", tip, `refs/heads/${base}`])) return undefined;
    const remotes = await git(source, ["branch", "-r", "--contains", tip, "--format=%(refname:short)"]);
    if (remotes.split("\n").some((r) => r.trim() !== "" && !r.endsWith("/HEAD"))) return undefined;
    return `${branch} is neither merged nor pushed`;
  } catch (err) {
    return `it could not be checked: ${errorMessage(err)}`;
  }
}
