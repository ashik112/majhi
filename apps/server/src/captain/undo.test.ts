import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { revertMerge } from "./undo.ts";

/**
 * Undo of the captain's merge (5.18): a revert commit on the target, later work kept, nothing
 * rewritten, and nothing changed when the revert would conflict or the checkout holds changes.
 */

const ME = { name: "majhi", email: "majhi@example.com" };
let dir: string;
let done: () => Promise<void>;

beforeEach(async () => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  // Whoever started the server: the revert is still made as the identity it is given.
  vi.stubEnv("GIT_AUTHOR_NAME", "Someone");
  vi.stubEnv("GIT_COMMITTER_NAME", "Someone");
  ({ dir, cleanup: done } = await tempDir());
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await done();
});

const tip = (repo: string, ref: string) => git(repo, "rev-parse", ref);
const read = (repo: string, file: string) => readFile(join(repo, file), "utf8");

/** A repo on main with app.txt, and a task branch that changes it and adds work.txt. */
async function repoWithTask(): Promise<string> {
  const repo = join(dir, "api");
  await makeRepo(repo);
  await writeFile(join(repo, "app.txt"), "one\n");
  await writeFile(join(repo, "notes.txt"), "notes\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "init");
  await git(repo, "checkout", "--quiet", "-b", "task");
  await writeFile(join(repo, "app.txt"), "two\n");
  await writeFile(join(repo, "work.txt"), "work\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "task work");
  await git(repo, "checkout", "--quiet", "main");
  return repo;
}

describe("undoing the captain's merge", () => {
  it("adds one revert commit on the checked-out target and keeps later work", async () => {
    const repo = await repoWithTask();
    const before = await tip(repo, "main");
    await git(repo, "merge", "--quiet", "--no-ff", "-m", "merge task", "task");
    const after = await tip(repo, "main");
    // Someone works on main after the merge, in another file.
    await writeFile(join(repo, "notes.txt"), "notes, later\n");
    await git(repo, "commit", "--quiet", "-am", "later work");
    const later = await tip(repo, "main");

    const head = await revertMerge(
      { project: "api", source: repo, into: "main", before, after },
      ME,
      "Revert the merge",
    );
    expect(head).toBe(await tip(repo, "main"));
    // A new commit on top: nothing rewritten.
    expect(await git(repo, "rev-parse", `${head}^`)).toBe(later);
    expect(await git(repo, "log", "-1", "--format=%s %an %cn")).toBe("Revert the merge majhi majhi");
    expect(await read(repo, "app.txt")).toBe("one\n");
    await expect(read(repo, "work.txt")).rejects.toThrow();
    expect(await read(repo, "notes.txt")).toBe("notes, later\n");
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("reverts a fast-forward on a branch checked out nowhere by moving it forward", async () => {
    const repo = await repoWithTask();
    await git(repo, "branch", "develop", "main");
    const before = await tip(repo, "develop");
    await git(repo, "update-ref", "refs/heads/develop", await tip(repo, "task"), before);
    const after = await tip(repo, "develop");
    const head = await revertMerge(
      { project: "api", source: repo, into: "develop", before, after },
      ME,
      "Revert",
    );
    expect(await tip(repo, "develop")).toBe(head);
    expect(await git(repo, "rev-parse", `${head}^`)).toBe(after);
    expect(await git(repo, "show", "develop:app.txt")).toBe("one");
    // The checkout on main did not move, and no worktree was left behind.
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect((await git(repo, "worktree", "list")).split("\n")).toHaveLength(1);
  });

  it("changes nothing when later work touched the same lines", async () => {
    const repo = await repoWithTask();
    const before = await tip(repo, "main");
    await git(repo, "merge", "--quiet", "--no-ff", "-m", "merge task", "task");
    const after = await tip(repo, "main");
    await writeFile(join(repo, "app.txt"), "three\n");
    await git(repo, "commit", "--quiet", "-am", "later edit of the same line");
    const later = await tip(repo, "main");
    await expect(
      revertMerge({ project: "api", source: repo, into: "main", before, after }, ME, "Revert"),
    ).rejects.toThrow("changed the same lines");
    expect(await tip(repo, "main")).toBe(later);
    expect(await read(repo, "app.txt")).toBe("three\n");
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses while the owner's checkout of the target holds uncommitted changes", async () => {
    const repo = await repoWithTask();
    const before = await tip(repo, "main");
    await git(repo, "merge", "--quiet", "--no-ff", "-m", "merge task", "task");
    const after = await tip(repo, "main");
    await writeFile(join(repo, "notes.txt"), "half typed\n");
    await expect(
      revertMerge({ project: "api", source: repo, into: "main", before, after }, ME, "Revert"),
    ).rejects.toThrow("has uncommitted changes on main");
    expect(await tip(repo, "main")).toBe(after);
    expect(await read(repo, "notes.txt")).toBe("half typed\n");
  });

  it("refuses when the target no longer holds the merge", async () => {
    const repo = await repoWithTask();
    const before = await tip(repo, "main");
    await git(repo, "branch", "elsewhere", "task");
    const after = await tip(repo, "task");
    await expect(
      revertMerge({ project: "api", source: repo, into: "main", before, after }, ME, "Revert"),
    ).rejects.toThrow("no longer holds the merge");
    expect(await tip(repo, "main")).toBe(before);
  });
});
