import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedLinesOf } from "./lines.ts";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();

describe("the size of a task's change", () => {
  it("is the same before and after its work landed in the base", async () => {
    const source = mkdtempSync(join(tmpdir(), "majhi-lines-"));
    git(source, "init", "--quiet", "--initial-branch", "main");
    writeFileSync(join(source, "a.txt"), "one\n");
    git(source, "add", ".");
    git(source, "commit", "--quiet", "-m", "init");
    const startCommit = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "--quiet", "-b", "task/x");
    writeFileSync(join(source, "b.txt"), "1\n2\n3\n");
    git(source, "add", ".");
    git(source, "commit", "--quiet", "-m", "work");
    const head = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "--quiet", "main");
    const repo = { source, base: "main", branch: "task/x", startCommit };
    expect(await changedLinesOf(repo)).toBe(3);
    git(source, "merge", "--quiet", "--ff-only", "task/x");
    // Merged: the branch has nothing left against the base, but the work is still 3 lines.
    expect(
      await changedLinesOf({
        ...repo,
        landed: { commit: head, into: "main", at: "2026-10-07T10:00:00.000Z" },
        shipped: { head, into: "main" },
      }),
    ).toBe(3);
  });
});
