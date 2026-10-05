import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRepo, tempDir, git as testGit } from "../testing/fixtures.ts";
import { MAX_DIFF_FILES, repoDiff } from "./diff.ts";

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

});
