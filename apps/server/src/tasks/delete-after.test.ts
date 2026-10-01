import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRepo } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { deleteAfterShip, deleteRefusal } from "./delete-after.ts";

let dir: string;
let dispose: () => Promise<void>;
let source: string;
let worktree: string;
const branch = "task/acm-1-fix";

const there = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const has = async (name: string) => (await git(source, "branch", "--list", name)).trim() !== "";
const head = async () => (await git(source, "rev-parse", branch)).trim();

function repo(over: Partial<TaskRepo> = {}): TaskRepo {
  return { project: "acme-api", source, base: "main", branch, worktree, createdBranch: true, ...over };
}

async function commitIn(cwd: string, file: string, text: string): Promise<void> {
  await writeFile(join(cwd, file), text);
  await git(cwd, "add", file);
  await git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file);
}

beforeEach(async () => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  ({ dir, cleanup: dispose } = await tempDir());
  source = join(dir, "work", "api");
  await makeRepo(source, { commit: true });
  worktree = join(dir, "tasks", "ACM-1", "acme-api");
  await git(source, "worktree", "add", "-q", "-b", branch, worktree);
  await commitIn(worktree, "fix.txt", "fix");
});
afterEach(() => dispose());

describe("deleteAfterShip", () => {
  it("removes the worktree and deletes the branch majhi created", async () => {
    const out = await deleteAfterShip({ repo: repo(), head: await head(), stacked: false });
    expect(out).toEqual({
      worktreeRemoved: true,
      branchDeleted: true,
      detail: `Deleted ${branch} and its worktree.`,
    });
    expect(await there(worktree)).toBe(false);
    expect(await has(branch)).toBe(false);
  });

  it("keeps both when the worktree has uncommitted changes, untracked files included", async () => {
    await writeFile(join(worktree, "notes.txt"), "not committed");
    expect(await deleteRefusal(repo())).toBe(
      "acme-api's worktree has uncommitted changes (1 file), so it cannot be deleted. Ask the agent to commit them, or ship without deleting.",
    );
    const out = await deleteAfterShip({ repo: repo(), head: await head(), stacked: false });
    expect(out).toMatchObject({ worktreeRemoved: false, branchDeleted: false });
    expect(await there(join(worktree, "notes.txt"))).toBe(true);
    expect(await has(branch)).toBe(true);
  });

  it("keeps both when the branch moved after it was shipped", async () => {
    const shipped = await head();
    await commitIn(worktree, "later.txt", "later");
    const out = await deleteAfterShip({ repo: repo(), head: shipped, stacked: false });
    expect(out).toMatchObject({ worktreeRemoved: false, branchDeleted: false });
    expect(out.detail).toContain("new commits since it was shipped");
    expect(await there(worktree)).toBe(true);
    expect(await has(branch)).toBe(true);
  });

  it("keeps a branch majhi did not create, or one another task builds on, and removes only the worktree", async () => {
    const named = await deleteAfterShip({
      repo: repo({ createdBranch: false }),
      head: await head(),
      stacked: false,
    });
    expect(named).toEqual({
      worktreeRemoved: true,
      branchDeleted: false,
      detail: `Removed the worktree. Kept ${branch}: majhi did not create it.`,
    });
    expect(await has(branch)).toBe(true);

    const stacked = await deleteAfterShip({
      repo: repo({ worktree: undefined }),
      head: await head(),
      stacked: true,
    });
    expect(stacked).toEqual({
      worktreeRemoved: false,
      branchDeleted: false,
      detail: `Kept ${branch}: another task builds on it.`,
    });
    expect(await has(branch)).toBe(true);
  });

  it("never deletes a branch checked out in another worktree", async () => {
    await git(source, "worktree", "remove", worktree);
    const other = join(dir, "other");
    await git(source, "worktree", "add", "-q", other, branch);
    const out = await deleteAfterShip({
      repo: repo({ worktree: undefined }),
      head: await head(),
      stacked: false,
    });
    expect(out).toMatchObject({ branchDeleted: false });
    expect(await has(branch)).toBe(true);
    expect(await there(other)).toBe(true);
  });
});
