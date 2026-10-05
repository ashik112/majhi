import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRepo } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRepo, tempDir, git as testGit } from "../testing/fixtures.ts";
import { repoDiff } from "./diff.ts";
import { commitsSinceStart } from "./since-start.ts";
import { createWorktree } from "./worktrees.ts";

let dir: string;
let cleanup: () => Promise<void>;
let source: string;
let worktree: string;
let startCommit: string | undefined;
let originHead: string;

async function commit(repo: string, file: string, text: string): Promise<void> {
  await writeFile(join(repo, file), text);
  await testGit(repo, "add", ".");
  await testGit(repo, "commit", "--quiet", "-m", `edit ${file}`);
}

const taskRepo = (extra: Partial<TaskRepo> = {}): TaskRepo => ({
  project: "acme-api",
  source,
  base: "main",
  branch: "task/acm-1",
  worktree,
  createdBranch: true,
  ...(startCommit === undefined ? {} : { startCommit }),
  ...extra,
});

/** Origin is 3 commits ahead of the local main when the task branch is cut from origin/main. */
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  const bare = join(dir, "origin.git");
  await mkdir(bare);
  await testGit(bare, "init", "--quiet", "--bare", "--initial-branch=main");
  source = join(dir, "acme-api");
  await makeRepo(source, { remotes: { origin: bare } });
  await commit(source, "a.txt", "one\n");
  await testGit(source, "push", "--quiet", "origin", "main");
  const other = join(dir, "other");
  await testGit(dir, "clone", "--quiet", bare, other);
  for (const n of ["x", "y", "z"]) await commit(other, `${n}.txt`, `${n}\n`);
  await testGit(other, "push", "--quiet", "origin", "main");
  originHead = await testGit(other, "rev-parse", "HEAD");
  worktree = join(dir, "tasks", "acme-api");
  const made = await createWorktree({ source, base: "main", branch: "task/acm-1", path: worktree });
  startCommit = made.startCommit;
});
afterEach(async () => {
  await cleanup();
});

describe("changes since the task started", () => {
  it("records origin/main as the start, although local main is stale", async () => {
    expect(startCommit).toBe(originHead);
    expect(await testGit(source, "rev-parse", "main")).not.toBe(originHead);
  });

  it("shows only the file the agent committed", async () => {
    await commit(worktree, "work.txt", "work\n");
    const diff = await repoDiff(taskRepo());
    expect(diff.files.map((f) => f.path)).toEqual(["work.txt"]);
    expect(diff.commits.map((c) => c.subject)).toEqual(["edit work.txt"]);
    expect(await commitsSinceStart(source, taskRepo())).toBe(1);
  });

  it("without a recorded start, uses the newest base copy the branch contains", async () => {
    startCommit = undefined;
    const none = await repoDiff(taskRepo());
    expect(none.files).toEqual([]);
    expect(none.since).toEqual({ label: "origin/main", commit: originHead });
    await commit(worktree, "work.txt", "work\n");
    const one = await repoDiff(taskRepo());
    expect(one.files.map((f) => f.path)).toEqual(["work.txt"]);
    expect(one.commits).toHaveLength(1);
  });

  it("ignores a recorded start the branch no longer holds", async () => {
    await commit(worktree, "work.txt", "work\n");
    const diff = await repoDiff(taskRepo({ startCommit: "0".repeat(40) }));
    expect(diff.files.map((f) => f.path)).toEqual(["work.txt"]);
  });
});
