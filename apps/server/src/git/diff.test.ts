import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRepo, tempDir, git as testGit } from "../testing/fixtures.ts";
import { MAX_DIFF_FILES, MAX_PATCH_BYTES, MAX_TOTAL_PATCH_BYTES, repoDiff } from "./diff.ts";

let dir: string;
let cleanup: () => Promise<void>;
let repo: string;

const read = () =>
  repoDiff({ project: "acme-api", source: repo, base: "main", branch: "task", worktree: repo });

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  repo = join(dir, "acme-api");
  await makeRepo(repo);
  await writeFile(join(repo, "a.txt"), "one\ntwo\n");
  await testGit(repo, "add", ".");
  await testGit(repo, "commit", "--quiet", "-m", "init");
  await testGit(repo, "checkout", "--quiet", "-b", "task");
});
afterEach(async () => {
  await cleanup();
});

describe("repoDiff", () => {
  it("lists the branch's commits with the agent that committed each", async () => {
    await writeFile(join(repo, "a.txt"), "one\nTWO\n");
    await testGit(repo, "add", ".");
    await testGit(
      repo,
      "-c",
      "committer.name=acme-dev via majhi",
      "-c",
      "committer.email=majhi@majhi.local",
      "commit",
      "--quiet",
      "-m",
      "by an agent",
    );
    await writeFile(join(repo, "a.txt"), "three\n");
    await testGit(repo, "commit", "--quiet", "-am", "by hand");
    const { commits } = await read();
    expect(commits.map((c) => [c.subject, c.agent])).toEqual([
      ["by hand", undefined],
      ["by an agent", "acme-dev"],
    ]);
  });

  it("says a branch is gone only once the task has started", async () => {
    const missing = { project: "acme-api", source: repo, base: "main", branch: "task/not-made-yet" };
    const before = await repoDiff(missing, { started: false });
    expect(before).toMatchObject({ files: [], uncommitted: false });
    expect(before.error).toBeUndefined();
    expect((await repoDiff(missing)).error).toBe("The branch is gone, so there is nothing to show.");
  });

  it("shows commits and uncommitted changes, and new files as added", async () => {
    await writeFile(join(repo, "a.txt"), "one\nTWO\n");
    await testGit(repo, "commit", "--quiet", "-am", "edit");
    await writeFile(join(repo, "new.txt"), "hello\n");
    const diff = await read();
    expect(diff.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 1, 1],
      ["new.txt", "added", 1, 0],
    ]);
    expect(diff.uncommitted).toBe(true);
  });

  it("never follows an untracked symlink out of the worktree", async () => {
    const secret = join(dir, "secret.txt");
    await writeFile(secret, "TOP-SECRET\n");
    await symlink(secret, join(repo, "link.txt"));
    await symlink(dir, join(repo, "outside"));
    const diff = await read();
    const link = diff.files.find((f) => f.path === "link.txt");
    expect(link?.patch).toContain(secret);
    expect(JSON.stringify(diff)).not.toContain("TOP-SECRET");
    expect(diff.files.find((f) => f.path === "outside")?.patch).toContain(dir);
  });

  it("does not run a textconv program from the repo's config", async () => {
    const marker = join(dir, "ran");
    await writeFile(join(repo, ".gitattributes"), "*.txt diff=evil\n");
    await testGit(repo, "config", "diff.evil.textconv", `sh -c 'touch ${marker}; cat "$0"'`);
    await writeFile(join(repo, "a.txt"), "changed\n");
    await read();
    await expect(access(marker)).rejects.toThrow();
  });

  it("opens no more untracked files than the list has room for, and counts the rest", async () => {
    await mkdir(join(repo, "out"));
    const extra = 25;
    await Promise.all(
      Array.from({ length: MAX_DIFF_FILES + extra }, (_, i) =>
        writeFile(join(repo, "out", `f${i}.txt`), "x\n"),
      ),
    );
    const diff = await read();
    expect(diff.files).toHaveLength(MAX_DIFF_FILES);
    expect(diff.omitted).toBe(extra);
  });

  it("stops giving patches once the repo's total is used up", async () => {
    const size = MAX_PATCH_BYTES - 1000;
    const count = Math.ceil(MAX_TOTAL_PATCH_BYTES / size) + 3;
    const line = `${"y".repeat(99)}\n`;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        writeFile(join(repo, `big${String(i).padStart(2, "0")}.txt`), line.repeat(size / 100)),
      ),
    );
    const diff = await read();
    const total = diff.files.reduce((sum, f) => sum + f.patch.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_PATCH_BYTES);
    const cut = diff.files.filter((f) => f.truncated);
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.every((f) => f.patch === "")).toBe(true);
  });
});
