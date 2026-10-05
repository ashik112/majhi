import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDirectory } from "../fs.ts";
import { TerminalManager } from "../terminal/manager.ts";
import { openTaskTerminal } from "../terminal/task-terminal.ts";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { repairWorktrees, repoMounts } from "./launch.ts";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(() => cleanup());

/** A task with one repo on `branch`, worked on in a real worktree. */
async function taskOn(
  branch: string,
  seen: (source: string) => Promise<string> | string = (s) => s,
): Promise<{ task: Task; git: string; entry: string }> {
  const real = join(dir, "api");
  await makeRepo(real, { commit: true });
  const worktree = join(dir, "tasks", "ACM-7", "wt");
  await git(real, "worktree", "add", "--quiet", "-b", branch, worktree);
  // `seen`: the path majhi knows the repo by, which may differ from the one git wrote down.
  const source = await seen(real);
  const repo = { project: "api", source, branch, base: "main", worktree, createdBranch: true };
  const gitDir = join(source, ".git");
  const task = { id: "ACM-7", folder: join(dir, "tasks", "ACM-7"), repos: [repo] } as unknown as Task;
  return { task, git: gitDir, entry: join(gitDir, "worktrees", "wt") };
}

describe("a run's mounts of a task repo's git folder", () => {
  it("make other worktrees' entries and the refs read-only, but the run's own and majhi's task branches", async () => {
    const { task, git, entry } = await taskOn("task/acm-7-work");
    expect(await repoMounts(task, { guardRefs: true })).toEqual([
      { path: git },
      { path: join(git, "config"), readOnly: true },
      { path: join(git, "hooks"), readOnly: true },
      { path: join(git, "worktrees"), readOnly: true },
      { path: entry },
      { path: join(git, "refs", "heads"), readOnly: true },
      { path: join(git, "refs", "heads", "task") },
      { path: join(git, "refs", "remotes"), readOnly: true },
      { path: join(git, "refs", "tags"), readOnly: true },
    ]);
  });

  it("keep the writable task folder when git packs the refs on the host", async () => {
    const { task, git: gitDir } = await taskOn("task/acm-7-work");
    await repoMounts(task, { guardRefs: true });
    const folder = join(gitDir, "refs", "heads", "task");
    await git(join(gitDir, ".."), "pack-refs", "--all", "--prune");
    expect(await isDirectory(folder)).toBe(true);
    // The branch is packed, and git reads the folder with its dot-file as no ref.
    expect(await git(join(gitDir, ".."), "for-each-ref", "--format=%(refname)", "refs/heads/task")).toBe(
      "refs/heads/task/acm-7-work",
    );
  });

  it("keep a branch the owner named writable, and the refs of the owner's own terminal", async () => {
    // A branch majhi created under the owner's name: its own folder stays writable, the rest is guarded.
    const named = await taskOn("feature/login");
    const mounts = await repoMounts(named.task, { guardRefs: true });
    expect(mounts).toContainEqual({ path: join(named.git, "refs", "heads", "feature") });
    expect(mounts).toContainEqual({ path: join(named.git, "refs", "heads"), readOnly: true });
    await cleanup();
    ({ dir, cleanup } = await tempDir());
    const own = await taskOn("task/acm-7-work");
    expect(await repoMounts(own.task)).toEqual([
      { path: own.git },
      { path: join(own.git, "config"), readOnly: true },
      { path: join(own.git, "hooks"), readOnly: true },
      { path: join(own.git, "worktrees"), readOnly: true },
      { path: own.entry },
    ]);
  });

  it("find the run's own entry when the repo is known by a symlinked path", async () => {
    const { task, git, entry } = await taskOn("task/acm-7-work", async (real) => {
      const link = join(dir, "linked");
      await symlink(real, link);
      return link;
    });
    const warn = vi.fn();
    const mounts = await repoMounts(task, { guardRefs: true, warn });
    expect(mounts).toContainEqual({ path: join(git, "worktrees"), readOnly: true });
    expect(mounts).toContainEqual({ path: entry });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keep every entry read-only and say so when the run's own entry cannot be found", async () => {
    const { task, git } = await taskOn("task/acm-7-work");
    const worktree = task.repos[0]?.worktree ?? "";
    await mkdir(join(dir, "elsewhere", "wt"), { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${join(dir, "elsewhere", "wt")}\n`);
    const warn = vi.fn();
    const mounts = await repoMounts(task, { guardRefs: true, warn });
    expect(mounts.filter((m) => m.path.startsWith(join(git, "worktrees")))).toEqual([
      { path: join(git, "worktrees"), readOnly: true },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/^Could not find the git entry of /);
  });
});

describe("the task terminal", () => {
  it("gets other worktrees' entries read-only, so a `git worktree prune` there drops none", async () => {
    const { task, git, entry } = await taskOn("task/acm-7-work");
    let mounts: unknown[] = [];
    await expect(
      openTaskTerminal(
        {
          terminals: new TerminalManager(),
          task: () => task,
          tasksDir: async () => join(dir, "tasks"),
          base: { PATH: "/usr/bin:/bin" },
          repoMounts,
          tty: async (req) => {
            mounts = req.mounts ?? [];
            throw new Error("no runner in this test");
          },
        },
        task.id,
      ),
    ).rejects.toThrow("no runner");
    expect(mounts).toContainEqual({ path: join(git, "worktrees"), readOnly: true });
    expect(mounts).toContainEqual({ path: entry });
  });
});

describe("waking an agent on a task", () => {
  it("repairs a worktree whose entry is gone, says so, and mounts the entry", async () => {
    const { task, entry } = await taskOn("task/acm-7-work");
    await rm(entry, { recursive: true });
    const lines = await repairWorktrees(task);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Repaired the git link of /);
    expect((await repoMounts(task, { guardRefs: true })).map((m) => m.path)).toContain(entry);
    expect(await repairWorktrees(task)).toEqual([]);
  });

  it("locks a worktree made before majhi locked them, so a prune that cannot see it keeps its entry", async () => {
    const { task } = await taskOn("task/acm-7-work");
    const source = task.repos[0]?.source ?? "";
    expect(await git(source, "worktree", "list", "--porcelain")).not.toContain("locked");
    expect(await repairWorktrees(task)).toEqual([]);
    expect(await git(source, "worktree", "list", "--porcelain")).toContain("locked majhi task ACM-7");
    // Waking again is fine with the lock already there.
    expect(await repairWorktrees(task)).toEqual([]);
    await rm(task.folder, { recursive: true });
    await git(source, "worktree", "prune");
    expect(await git(source, "worktree", "list", "--porcelain")).toContain("locked majhi task ACM-7");
  });
});
