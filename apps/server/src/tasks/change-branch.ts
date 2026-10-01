import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Actor,
  type ChangeBranchInput,
  type ChangeBranchResult,
  repoPathProblem,
  type Task,
  type TaskId,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import { git } from "../git/git.ts";
import type { RoomService } from "../room/service.ts";
import type { WorktreeLocks } from "../rooms/locks.ts";
import { type CommitBy, commitPaths } from "../runs/checkpoint.ts";

/**
 * `tasks.changeBranch`: a change to another task's branch, made inside that task's own worktree.
 * Every task worktree shares its repo's git folder, so a plain `git commit` or `update-ref` from
 * one task can move another task's branch while that worktree's index and files stay behind, and
 * its agents then revert the change with their next commit. Committing in the target's worktree
 * keeps its files, index and branch in step.
 */

export interface ChangeBranchDeps {
  tasks: { get(id: string): Task | undefined };
  /** Agents of a task that are mid-turn or have work queued. */
  working(task: string): readonly string[];
  /** The worktree locks agents take for a turn: held here while the commit is made. */
  locks: WorktreeLocks;
  room: Pick<RoomService, "post">;
  /** Who the commit is made as, in that repo of the target task. */
  commitBy(target: Task, project: string, agent: string | undefined): Promise<CommitBy>;
  /** True for a root agent, which may change tasks of any org. */
  isRoot(agent: string): Promise<boolean>;
}

export interface ChangeBranchCaller {
  actor: Actor;
  /** The task the calling agent runs in. Absent for the owner. */
  task?: string | undefined;
  reason?: string | undefined;
}

export async function changeTaskBranch(
  deps: ChangeBranchDeps,
  input: ChangeBranchInput,
  caller: ChangeBranchCaller,
): Promise<ChangeBranchResult> {
  const target = deps.tasks.get(input.task);
  if (target === undefined) throw new UserError(`Task ${input.task} does not exist.`, 404);
  const agent = caller.actor.kind === "agent" ? caller.actor.id : undefined;
  if (agent !== undefined) await checkCaller(deps, target, agent, caller.task);
  if (target.status === "done") {
    throw new UserError(`${target.id} is done. Reopen it before changing its branch.`, 409);
  }
  const repo = repoOf(target, input.project);
  const worktree = repo.worktree;
  if (worktree === undefined) {
    throw new UserError(`${target.id} has no worktree for ${repo.project} yet. Start it first.`, 409);
  }
  const busy = deps.working(target.id);
  if (busy.length > 0) {
    throw new UserError(
      `${busy.map((a) => `@${a}`).join(", ")} in ${target.id} ${busy.length === 1 ? "is" : "are"} working or ${busy.length === 1 ? "has" : "have"} work queued. Retry when ${target.id} is idle.`,
      409,
    );
  }
  const holder = deps.locks.holder(worktree);
  if (holder !== undefined) {
    throw new UserError(
      `Someone is working in the ${repo.project} worktree of ${target.id}. Retry when it is idle.`,
      409,
    );
  }
  // Taken in the same step as the checks above, so a turn that starts now waits for this commit.
  const release = await deps.locks.acquire([worktree], `${caller.task ?? "owner"}\u0000${agent ?? "owner"}`);
  try {
    const { commit, files } = await commitInWorktree(deps, target, repo, worktree, input, agent);
    const who = agent === undefined ? "The owner" : `@${agent}`;
    const reason = caller.reason?.trim() ?? "";
    deps.room.post(target.id as TaskId, `info:${crypto.randomUUID()}`, {
      type: "system",
      level: "info",
      text: `${who} changed ${fileList(files)} on ${repo.branch}${reason === "" ? "" : `: ${reason}`} (${commit.slice(0, 7)})`,
    });
    return { task: target.id, project: repo.project, branch: repo.branch, commit, files };
  } finally {
    release();
  }
}

/** Same org as the caller's task, or a root agent. Never the caller's own task. */
async function checkCaller(
  deps: ChangeBranchDeps,
  target: Task,
  agent: string,
  callerTaskId: string | undefined,
): Promise<void> {
  if (callerTaskId === target.id) {
    throw new UserError(`${target.id} is your own task: commit in your own worktree with git.`, 409);
  }
  if (await deps.isRoot(agent)) return;
  const callerTask = callerTaskId === undefined ? undefined : deps.tasks.get(callerTaskId);
  if (callerTask === undefined || callerTask.org !== target.org) {
    throw new UserError(
      `${target.id} is in another org: you can only change branches of tasks in your own org.`,
    );
  }
}

function repoOf(target: Task, project: string | undefined): Task["repos"][number] {
  if (target.repos.length === 0) throw new UserError(`${target.id} has no repo with a branch.`, 409);
  if (project === undefined) {
    const [only, ...more] = target.repos;
    if (only === undefined || more.length > 0) {
      throw new UserError(
        `${target.id} has more than one repo: name one in project (${target.repos.map((r) => r.project).join(", ")}).`,
      );
    }
    return only;
  }
  const repo = target.repos.find((r) => r.project === project);
  if (repo === undefined) throw new UserError(`${target.id} has no repo ${project}.`, 404);
  return repo;
}

async function commitInWorktree(
  deps: ChangeBranchDeps,
  target: Task,
  repo: Task["repos"][number],
  worktree: string,
  input: ChangeBranchInput,
  agent: string | undefined,
): Promise<{ commit: string; files: string[] }> {
  const head = (await git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
  if (head !== repo.branch) {
    throw new UserError(
      `The ${repo.project} worktree of ${target.id} is not on ${repo.branch}${head === "" ? "" : ` (it is on ${head})`}.`,
      409,
    );
  }
  // Someone's work that is not committed is never mixed into this commit or thrown away.
  const dirty = (await git(worktree, ["status", "--porcelain", "--untracked-files=all"]))
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 5).map((l) => l.slice(3));
    throw new UserError(
      `The ${repo.project} worktree of ${target.id} has uncommitted changes (${shown.join(", ")}${dirty.length > 5 ? ", ..." : ""}). Ask its agents or the owner to commit them first.`,
      409,
    );
  }
  // The caller read the branch at `base`: a newer head means its edit could undo someone's work.
  const tip = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  const read = (
    await git(worktree, ["rev-parse", "--verify", "--quiet", `${input.base}^{commit}`]).catch(() => "")
  ).trim();
  if (read !== tip) {
    throw new UserError(
      `${repo.branch} moved since you read it: it is at ${tip.slice(0, 7)} now, you read ${input.base.slice(0, 7)}. Read the files again at ${tip.slice(0, 7)} and retry.`,
      409,
    );
  }
  const patchFile = input.patch === undefined ? undefined : await stagePatch(input.patch);
  try {
    const paths =
      patchFile === undefined
        ? (input.files ?? []).map((f) => f.path)
        : await patchPaths(worktree, patchFile, input.patch ?? "");
    for (const path of paths) await checkInside(worktree, path);
    // An ignored file (a local .env, say) is not the branch's: writing it would change it for nobody's commit.
    const ignored = (await git(worktree, ["check-ignore", "--", ...paths]).catch(() => "")).trim();
    if (ignored !== "")
      throw new UserError(`${ignored.split("\n").join(", ")} is ignored by git in that repo.`);
    try {
      if (patchFile === undefined) {
        for (const file of input.files ?? []) {
          const path = join(worktree, file.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.content);
        }
      } else {
        await git(worktree, ["apply", "--check", "--3way", patchFile.path]).catch((err: unknown) => {
          throw new UserError(`The patch does not apply to ${repo.branch}: ${errorLine(err)}`, 409);
        });
        await git(worktree, ["apply", "--3way", "--index", patchFile.path]).catch((err: unknown) => {
          throw new UserError(`The patch does not apply to ${repo.branch}: ${errorLine(err)}`, 409);
        });
      }
      const by = await deps.commitBy(target, repo.project, agent);
      const commit = await commitPaths(worktree, paths, input.message, by);
      if (commit === undefined)
        throw new UserError("Those changes are already in the branch: nothing to commit.", 409);
      return { commit, files: paths };
    } catch (err) {
      // The worktree was clean before: put back only what this call touched.
      await restore(worktree, paths);
      throw err;
    }
  } finally {
    if (patchFile !== undefined) await rm(patchFile.dir, { recursive: true, force: true });
  }
}

function errorLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).trim().split("\n")[0] ?? "";
}

/** The patch goes to a file outside the worktree, for `git apply` to read. */
async function stagePatch(patch: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "majhi-patch-"));
  const path = join(dir, "change.patch");
  await writeFile(path, patch.endsWith("\n") ? patch : `${patch}\n`);
  return { dir, path };
}

/** Every path a patch touches (both sides of a rename or copy), each held to the rules for a file path. */
async function patchPaths(worktree: string, file: { path: string }, patch: string): Promise<string[]> {
  // A link or a submodule in a patch could point a later write out of the worktree.
  if (/^(?:new file mode|deleted file mode|old mode|new mode) (?:120000|160000)\s*$/m.test(patch)) {
    throw new UserError("A patch may not add or change a symlink or a submodule.");
  }
  const out = await git(worktree, ["apply", "--numstat", "-z", file.path]).catch((err: unknown) => {
    throw new UserError(`The patch is not a valid diff: ${errorLine(err)}`);
  });
  const fields = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (head === "") continue;
    const m = /^(?:\d+|-)\t(?:\d+|-)\t(.*)$/s.exec(head);
    if (m === null) continue;
    if (m[1] === "") {
      // A rename or copy: the old and the new path follow as their own fields.
      paths.push(fields[i + 1] ?? "", fields[i + 2] ?? "");
      i += 2;
    } else paths.push(m[1] ?? "");
  }
  if (paths.length === 0) throw new UserError("The patch changes no files.");
  for (const path of paths) {
    const problem = path === "" ? "is empty" : repoPathProblem(path);
    if (problem !== undefined) throw new UserError(`${path} ${problem}.`);
  }
  return [...new Set(paths)];
}

/** Refuses a path that runs through a symlink or ends on a folder, so a write cannot leave the worktree. */
async function checkInside(worktree: string, path: string): Promise<void> {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const at = join(worktree, ...parts.slice(0, i));
    const info = await lstat(at).catch(() => undefined);
    if (info === undefined) return;
    if (info.isSymbolicLink())
      throw new UserError(`${path} goes through a symlink (${parts.slice(0, i).join("/")}).`);
    const last = i === parts.length;
    if (last && !info.isFile()) throw new UserError(`${path} is not a file.`);
    if (!last && !info.isDirectory())
      throw new UserError(`${path}: ${parts.slice(0, i).join("/")} is not a folder.`);
  }
}

const LITERAL = { env: { GIT_LITERAL_PATHSPECS: "1" } };

async function restore(worktree: string, paths: readonly string[]): Promise<void> {
  await git(worktree, ["reset", "--quiet", "--", ...paths], LITERAL).catch(() => undefined);
  // One by one: a new file is not in HEAD, and one missing path fails a checkout of them all.
  for (const path of paths) {
    await git(worktree, ["checkout", "--quiet", "HEAD", "--", path], LITERAL).catch(() => undefined);
  }
  await git(worktree, ["clean", "--quiet", "--force", "--", ...paths], LITERAL).catch(() => undefined);
}

function fileList(files: readonly string[]): string {
  if (files.length <= 3) return files.join(", ");
  return `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`;
}
