import type {
  CleanupPreview,
  CleanupReport,
  CleanupStep,
  CleanupTask,
  RemoteConfig,
  Task,
  TaskId,
  TaskRepo,
} from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import { FETCH_TIMEOUT_MS, git, gitOk, localBranchExists, refIsThere } from "../git/git.ts";
import { dirtyWorktrees, removeWorktree } from "../git/worktrees.ts";
import { mrRemoteName } from "../mrs/remote.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import { dependencyCaches, removeDependencyCache } from "./dependency-caches.ts";

const DAY_MS = 86_400_000;
/** Id prefix of the note a cleanup leaves in a room. The note is not counted as a log. */
const NOTE_PREFIX = "cleanup-note:";

export interface CleanupDeps {
  store: Store;
  room: RoomService;
  events: EventHub;
  /** The registered projects, for the remote each one's MRs go to. */
  projects: { get(id: string): Promise<{ remotes?: Readonly<Record<string, RemoteConfig>> }> };
  now?: () => Date;
}

/** A step and what a run needs to do it. */
interface Planned extends CleanupStep {
  repo: TaskRepo;
  /** Cache steps: the worktree has uncommitted changes. */
  treeDirty?: boolean;
}

/**
 * Cleanup of tasks done for a while: their worktrees, merged task branches and room logs. The task
 * row, its memory records and its plans stay. A preview and a run both work from the same
 * checks, and a run looks again at every task: it never trusts an earlier preview. Nothing is
 * forced: a worktree with uncommitted changes and a branch that is not merged stay.
 */
export class CleanupService {
  private running = false;

  constructor(private readonly deps: CleanupDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private cutoff(days: number): string {
    return new Date(this.now().getTime() - days * DAY_MS).toISOString();
  }

  /** Done tasks older than `days` that have something to clean up or something to say about it. */
  async preview(days: number, cachesOnly = false, cachesAfterDays?: number): Promise<CleanupPreview> {
    const tasks: CleanupTask[] = [];
    const age = cachesOnly ? (cachesAfterDays ?? 0) : days;
    for (const { id, doneAt } of this.deps.store.tasks.doneBefore(this.cutoff(age))) {
      const task = this.deps.store.tasks.get(id);
      if (task === undefined) continue;
      const planned = await this.plan(task);
      const steps = cachesOnly ? this.cacheSteps(planned, cachesAfterDays) : planned;
      const roomItems = cachesOnly ? 0 : this.deps.store.room.count(id, NOTE_PREFIX);
      if (steps.length === 0 && roomItems === 0) continue;
      tasks.push({ id: task.id, title: task.title, doneAt, steps: steps.map(publicStep), roomItems });
    }
    return { days, tasks, ...(cachesOnly ? { cachesOnly: true } : {}) };
  }

  /**
   * `cachesAfterDays` makes a caches-only run the automatic one: a task done for fewer days, or with
   * uncommitted changes in its worktree, is left alone.
   */
  async run(
    ids: readonly string[],
    days: number,
    by: string,
    cachesOnly = false,
    cachesAfterDays?: number,
  ): Promise<CleanupReport> {
    if (this.running) throw new UserError("A cleanup is already running.", 409);
    this.running = true;
    try {
      const report: CleanupReport = { tasks: [] };
      for (const id of new Set(ids))
        report.tasks.push(await this.cleanTask(id, days, by, cachesOnly, cachesAfterDays));
      this.deps.events.emit(["tasks"]);
      return report;
    } finally {
      this.running = false;
    }
  }

  private async cleanTask(
    id: string,
    days: number,
    by: string,
    cachesOnly: boolean,
    cachesAfterDays?: number,
  ): Promise<CleanupReport["tasks"][number]> {
    const { store } = this.deps;
    const task = store.tasks.get(id);
    const left = (title: string, skipped: string, doneAt = "") => ({
      id: id as TaskId,
      title,
      doneAt,
      steps: [],
      roomItems: 0,
      skipped,
    });
    if (task === undefined) return left(id, "There is no such task.");
    if (task.status !== "done") return left(task.title, `It is ${task.status}, not done.`, task.updatedAt);
    if (!cachesOnly && task.updatedAt >= this.cutoff(days)) {
      return left(task.title, `It was closed less than ${days} days ago.`, task.updatedAt);
    }
    if (cachesOnly && cachesAfterDays !== undefined && task.updatedAt >= this.cutoff(cachesAfterDays)) {
      return left(task.title, `It was closed less than ${cachesAfterDays} days ago.`, task.updatedAt);
    }

    const steps: CleanupStep[] = [];
    const planned = await this.plan(task);
    for (const step of cachesOnly
      ? this.cacheSteps(planned, cachesAfterDays)
      : planned.filter((p) => p.kind === "cache")) {
      try {
        const removed =
          step.repo.worktree !== undefined && (await removeDependencyCache(step.repo.worktree, step.name));
        steps.push(
          removed
            ? publicStep(step)
            : { ...publicStep(step), action: "skip", reason: "it is no longer an ignored dependency cache" },
        );
      } catch (err) {
        steps.push({
          ...publicStep(step),
          action: "skip",
          reason: `could not remove it: ${errorMessage(err)}`,
        });
      }
    }
    if (cachesOnly) {
      if (steps.some((s) => s.action === "remove")) {
        this.note(task, steps, 0);
        store.permissions.log({
          task: task.id,
          agent: by,
          kind: "cleanup",
          title: summarize(steps, 0),
          decision: "allow",
          by: "owner",
          at: this.now().toISOString(),
        });
      }
      return { id: task.id, title: task.title, doneAt: task.updatedAt, steps, roomItems: 0 };
    }
    // Worktrees first: a branch that is still checked out cannot be deleted.
    const failedTrees = new Set<string>();
    for (const step of planned.filter((p) => p.kind === "worktree")) {
      if (step.action === "skip") {
        steps.push(publicStep(step));
        failedTrees.add(step.project);
        continue;
      }
      try {
        await removeWorktree(step.repo.source, step.name, false);
        store.tasks.clearWorktree(task.id, step.project);
        steps.push(publicStep(step));
      } catch (err) {
        failedTrees.add(step.project);
        steps.push({
          ...publicStep(step),
          action: "skip",
          reason: `could not remove it: ${errorMessage(err)}`,
        });
      }
    }
    for (const step of planned.filter((p) => p.kind === "branch")) {
      if (step.action === "skip") {
        steps.push(publicStep(step));
      } else if (failedTrees.has(step.project)) {
        steps.push({ ...publicStep(step), action: "skip", reason: "its worktree is kept" });
      } else {
        try {
          const unsafe = await this.unsafeToDelete(step.repo);
          if (unsafe !== undefined) {
            steps.push({ ...publicStep(step), action: "skip", reason: unsafe });
            continue;
          }
          // `-D`: unsafeToDelete just proved every commit kept elsewhere. `-d` would check again
          // against the checkout's current branch, and fail for a branch merged only on the remote.
          await git(step.repo.source, ["branch", "-D", step.name]);
          steps.push(publicStep(step));
        } catch (err) {
          steps.push({
            ...publicStep(step),
            action: "skip",
            reason: `could not delete it: ${errorMessage(err)}`,
          });
        }
      }
    }

    this.deps.room.flush(task.id);
    const roomItems = store.room.deleteAll(task.id);
    const removed = steps.filter((s) => s.action === "remove");
    if (removed.length > 0 || roomItems > 0) {
      this.note(task, steps, roomItems);
      store.permissions.log({
        task: task.id,
        agent: by,
        kind: "cleanup",
        title: summarize(steps, roomItems),
        decision: "allow",
        by: "owner",
        at: this.now().toISOString(),
      });
    }
    const current = store.tasks.get(task.id);
    if (current !== undefined) this.deps.room.publishTask(current);
    return { id: task.id, title: task.title, doneAt: task.updatedAt, steps, roomItems };
  }

  /** The cache steps. The automatic pass (with an age) skips a worktree with uncommitted changes. */
  private cacheSteps(planned: readonly Planned[], cachesAfterDays: number | undefined): Planned[] {
    return planned.filter(
      (p) => p.kind === "cache" && (cachesAfterDays === undefined || p.treeDirty !== true),
    );
  }

  private note(task: Task, steps: readonly CleanupStep[], roomItems: number): void {
    const date = this.now().toISOString().slice(0, 10);
    const kept = steps.filter((s) => s.action === "skip");
    const text = `Cleaned up on ${date}: ${summarize(steps, roomItems)}.${
      kept.length === 0
        ? ""
        : ` Kept: ${kept.map((s) => `${s.kind} ${s.name} (${s.reason ?? "kept"})`).join("; ")}.`
    }`;
    this.deps.room.post(task.id, `${NOTE_PREFIX}${this.now().toISOString()}`, {
      type: "system",
      level: "info",
      text,
    });
  }

  /**
   * Why deleting the branch could lose commits, or undefined when its tip is kept elsewhere: it is in
   * the local base, or in the remote's base or branch as fetched right now. A remote-tracking ref can
   * be stale or missing, and an MR recorded as merged (by hand, with `markMerged` force) proves
   * nothing, so neither counts here. A fetch that fails keeps the branch.
   */
  private async unsafeToDelete(repo: TaskRepo): Promise<string | undefined> {
    const { source, branch, base } = repo;
    const tip = await git(source, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).then(
      (s) => s.trim(),
      () => undefined,
    );
    if (tip === undefined) return "it could not be read";
    if (await gitOk(source, ["merge-base", "--is-ancestor", tip, `refs/heads/${base}`])) return undefined;
    const remote = await this.remoteOf(repo);
    if (!(await gitOk(source, ["remote", "get-url", remote]))) {
      return `it is not in ${base} here, and there is no remote ${remote} to check`;
    }
    const failures: string[] = [];
    for (const name of new Set([base, branch])) {
      const fetched = await fetchTip(source, remote, name);
      if (fetched.failed !== undefined) failures.push(`could not fetch ${remote}/${name}: ${fetched.failed}`);
      else if (
        fetched.tip !== undefined &&
        (await gitOk(source, ["merge-base", "--is-ancestor", tip, fetched.tip]))
      )
        return undefined;
    }
    if (failures.length > 0) return `it is not in ${base} here and ${failures.join("; ")}`;
    return `its commits are not in ${base}, here or on ${remote}, and ${remote} has no branch that holds them`;
  }

  /** The remote the project's MRs go to, `origin` when the project is unknown. */
  private async remoteOf(repo: TaskRepo): Promise<string> {
    const project = await this.deps.projects.get(repo.project).catch(() => undefined);
    return mrRemoteName(project?.remotes);
  }

  /** What a cleanup of this task would do now, worktrees before branches. */
  private async plan(task: Task): Promise<Planned[]> {
    const caches: Planned[] = [];
    const trees: Planned[] = [];
    const branches: Planned[] = [];
    const stackedOn = this.deps.store.tasks.stackedOn(task.id);
    for (const repo of task.repos) {
      let treeKept = false;
      if (repo.worktree !== undefined) {
        for (const name of await dependencyCaches(repo.worktree).catch(() => [] as string[])) {
          caches.push({ kind: "cache", project: repo.project, name, action: "remove", repo });
        }
        const [dirty] = await dirtyWorktrees([repo.worktree]);
        treeKept = dirty !== undefined;
        if (dirty !== undefined) for (const c of caches) if (c.repo === repo) c.treeDirty = true;
        trees.push({
          kind: "worktree",
          project: repo.project,
          name: repo.worktree,
          action: dirty === undefined ? "remove" : "skip",
          ...(dirty === undefined
            ? {}
            : {
                reason: `it has uncommitted changes (${dirty.changes.length} ${dirty.changes.length === 1 ? "file" : "files"})`,
              }),
          repo,
        });
      }
      if (!(await localBranchExists(repo.source, repo.branch))) continue;
      const remote = await this.remoteOf(repo);
      const branch = { kind: "branch" as const, project: repo.project, name: repo.branch, repo };
      const skip = (reason: string) => branches.push({ ...branch, action: "skip", reason });
      if (!repo.createdBranch) {
        skip("the task did not create it");
      } else if (repo.branch === repo.base) {
        skip("it is the base branch");
      } else if (stackedOn.some((s) => s.project === repo.project && s.branch === repo.branch)) {
        skip("another task is stacked on it");
      } else if (treeKept) {
        skip("its worktree is kept");
      } else if (await mergedInto(repo, remote)) {
        branches.push({ ...branch, action: "remove" });
      } else if (repo.mr?.state === "merged") {
        // A squash merge leaves the branch unmerged as far as git can tell. Its commits are safe
        // when the remote still has the branch and holds everything local has.
        if (await unpushed(repo, remote)) skip("it has commits that were never pushed");
        else branches.push({ ...branch, action: "remove" });
      } else {
        skip(`it is not merged into ${repo.base}, and its merge request is not merged`);
      }
    }
    return [...caches, ...trees, ...branches];
  }
}

/** Whether the branch is an ancestor of its base, here or on the remote. */
async function mergedInto(repo: TaskRepo, remote: string): Promise<boolean> {
  const { source, branch, base } = repo;
  if (await gitOk(source, ["merge-base", "--is-ancestor", branch, base])) return true;
  const remoteBase = `${remote}/${base}`;
  return (
    (await refExists(source, `refs/remotes/${remoteBase}`)) &&
    (await gitOk(source, ["merge-base", "--is-ancestor", branch, remoteBase]))
  );
}

/** True when the remote still has the branch and the local branch holds commits it does not. */
async function unpushed(repo: TaskRepo, remote: string): Promise<boolean> {
  const { source, branch } = repo;
  if (!(await refExists(source, `refs/remotes/${remote}/${branch}`))) return false;
  return !(await gitOk(source, ["merge-base", "--is-ancestor", branch, `${remote}/${branch}`]));
}

/** Where cleanup fetches a remote branch to check it, outside the branches and tracking refs. */
const CHECK_REF = "refs/majhi/cleanup-check";

/**
 * The remote's `name` branch as it is now: its tip, or no tip when the remote has no such branch,
 * or why the fetch failed. Fetched into a ref of majhi's own, read and dropped, so no branch or
 * tracking ref of the owner moves.
 */
async function fetchTip(
  source: string,
  remote: string,
  name: string,
): Promise<{ tip?: string; failed?: string }> {
  try {
    await git(
      source,
      ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${name}:${CHECK_REF}`],
      { timeoutMs: FETCH_TIMEOUT_MS },
    );
  } catch (err) {
    const message = errorMessage(err);
    if (/couldn't find remote ref|could not find remote ref/i.test(message)) return {};
    return { failed: message.split("\n")[0] ?? message };
  }
  try {
    return { tip: (await git(source, ["rev-parse", "--verify", `${CHECK_REF}^{commit}`])).trim() };
  } finally {
    await git(source, ["update-ref", "-d", CHECK_REF]).catch(() => undefined);
  }
}

function refExists(source: string, ref: string): Promise<boolean> {
  return refIsThere(source, ref);
}

function publicStep(step: CleanupStep): CleanupStep {
  const { kind, project, name, action, reason } = step;
  return { kind, project, name, action, ...(reason === undefined ? {} : { reason }) };
}

function summarize(steps: readonly CleanupStep[], roomItems: number): string {
  const parts = steps
    .filter((s) => s.action === "remove")
    .map(
      (s) =>
        `${s.kind === "worktree" ? "removed worktree" : s.kind === "cache" ? "removed dependency cache" : "deleted branch"} ${s.name}`,
    );
  if (roomItems > 0) parts.push(`deleted ${roomItems} room items`);
  return parts.join(", ") || "nothing to remove";
}
