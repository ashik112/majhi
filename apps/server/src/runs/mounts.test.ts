import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "../testing/fixtures.ts";
import { repoMounts } from "./launch.ts";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(() => cleanup());

/** A task with one repo on `branch`, worked on in a worktree. */
async function taskOn(branch: string): Promise<{ task: Task; git: string }> {
  const source = join(dir, "api");
  await makeRepo(source, { commit: true });
  const repo = {
    project: "api",
    source,
    branch,
    base: "main",
    worktree: join(dir, "wt"),
    createdBranch: true,
  };
  return { task: { repos: [repo] } as unknown as Task, git: join(source, ".git") };
}

describe("a run's mounts of a task repo's git folder", () => {
  it("make the refs read-only, but majhi's task branches", async () => {
    const { task, git } = await taskOn("task/acm-7-work");
    expect(await repoMounts(task, { guardRefs: true })).toEqual([
      { path: git },
      { path: join(git, "config"), readOnly: true },
      { path: join(git, "hooks"), readOnly: true },
      { path: join(git, "refs", "heads"), readOnly: true },
      { path: join(git, "refs", "heads", "task") },
      { path: join(git, "refs", "remotes"), readOnly: true },
      { path: join(git, "refs", "tags"), readOnly: true },
    ]);
  });

  it("keep a branch the owner named writable, and the owner's own terminal unchanged", async () => {
    const named = await taskOn("feature/login");
    expect(await repoMounts(named.task, { guardRefs: true })).toHaveLength(3);
    await cleanup();
    ({ dir, cleanup } = await tempDir());
    const own = await taskOn("task/acm-7-work");
    expect(await repoMounts(own.task)).toHaveLength(3);
  });
});
