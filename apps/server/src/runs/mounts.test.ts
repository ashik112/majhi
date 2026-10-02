import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { repairWorktrees, repoMounts } from "./launch.ts";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(() => cleanup());

/** A task with one repo on `branch`, worked on in a real worktree. */
async function taskOn(branch: string): Promise<{ task: Task; git: string; entry: string }> {
  const source = join(dir, "api");
  await makeRepo(source, { commit: true });
  const worktree = join(dir, "wt");
  await git(source, "worktree", "add", "--quiet", "-b", branch, worktree);
  const repo = { project: "api", source, branch, base: "main", worktree, createdBranch: true };
  const gitDir = join(source, ".git");
  return { task: { repos: [repo] } as unknown as Task, git: gitDir, entry: join(gitDir, "worktrees", "wt") };
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

  it("keep a branch the owner named writable, and the owner's own terminal unchanged", async () => {
    const named = await taskOn("feature/login");
    expect((await repoMounts(named.task, { guardRefs: true })).map((m) => m.path)).not.toContain(
      join(named.git, "refs", "heads"),
    );
    await cleanup();
    ({ dir, cleanup } = await tempDir());
    const own = await taskOn("task/acm-7-work");
    expect(await repoMounts(own.task)).toHaveLength(3);
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
});
