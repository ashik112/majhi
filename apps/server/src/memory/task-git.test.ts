import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TaskRepo } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, makeRepo } from "../testing/fixtures.ts";
import { landedNow, repoFacts } from "./task-git.ts";

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo() {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  const path = await mkdtemp(join(tmpdir(), "majhi-git-"));
  dirs.push(path);
  await makeRepo(path, { commit: true });
  // The base's first commit is old: it is from before any task. The fixtures' git drops the
  // GIT_*_DATE variables, so the date is set here.
  const old = "2020-01-01T00:00:00Z";
  await run(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--amend",
      "--allow-empty",
      "--no-edit",
      "--quiet",
    ],
    {
      cwd: path,
      env: { ...process.env, GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old },
    },
  );
  await mkdir(join(path, "docs"), { recursive: true });
  const commit = async (file: string, text: string, message: string) => {
    await writeFile(join(path, file), text);
    await git(path, "add", ".");
    await git(path, "commit", "--quiet", "-m", message);
  };
  const task = (branch: string): TaskRepo => ({
    project: "acme-api",
    source: path,
    base: "main",
    branch,
    createdBranch: true,
  });
  return { path, commit, task };
}

const SINCE = "2000-01-01T00:00:00Z";

describe("what git says about a finished task's branch", () => {
  it("reads the branch's own commits, stat and docs, before and after a merge commit", async () => {
    const { path, commit, task } = await repo();
    await git(path, "checkout", "--quiet", "-b", "task/acm-1");
    await commit("health.ts", "export const ok = true;\n", "feat: health check");
    await commit("docs/PROGRESS.md", "# Progress\n\nThe health check works.\n", "docs: progress");
    await git(path, "checkout", "--quiet", "main");
    // The base moved on meanwhile: its commit is not the task's.
    await commit("other.ts", "x\n", "chore: other work");

    const before = await repoFacts(task("task/acm-1"), SINCE);
    expect(before.repo).toMatchObject({ merged: false, commits: 2 });
    expect(before.commits.map((c) => c.replace(/^\w+ /, ""))).toEqual([
      "feat: health check",
      "docs: progress",
    ]);
    expect(before.stat).toContain("health.ts");
    expect(before.stat).not.toContain("other.ts");
    expect(before.docs).toContain("The health check works.");

    await git(path, "merge", "--quiet", "--no-ff", "-m", "Merge ACM-1", "task/acm-1");
    const after = await repoFacts(task("task/acm-1"), SINCE);
    expect(after.repo).toMatchObject({ merged: true, commits: 2 });
    expect(after.commits).toEqual(before.commits);
    expect(after.stat).not.toContain("other.ts");
    expect(after.repo.head).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("reads a fast-forwarded branch from the task's start, and says when the branch is gone", async () => {
    const { path, commit, task } = await repo();
    const start = "2021-01-01T00:00:00Z";
    await git(path, "checkout", "--quiet", "-b", "task/acm-2");
    await commit("a.ts", "a\n", "feat: a");
    await git(path, "checkout", "--quiet", "main");
    await git(path, "merge", "--quiet", "--ff-only", "task/acm-2");
    const facts = await repoFacts(task("task/acm-2"), start);
    expect(facts.repo).toMatchObject({ merged: true, commits: 1 });
    expect(facts.commits[0]).toContain("feat: a");

    const gone = await repoFacts(task("task/acm-9"), start);
    expect(gone).toMatchObject({ repo: { commits: 0, merged: false }, problem: "The branch is gone." });
  });
});

describe("whether a finished task's branch is in its base now", () => {
  it("says no before a merge, yes after a squash merge, and still yes once the branch is gone", async () => {
    const { path, commit, task } = await repo();
    await git(path, "checkout", "--quiet", "-b", "task/acm-1");
    await commit("health.ts", "export const ok = true;\n", "feat: health check");
    await commit("docs/PROGRESS.md", "# Progress\n", "docs: progress");
    const head = await git(path, "rev-parse", "--short", "HEAD");
    await git(path, "checkout", "--quiet", "main");
    expect(await landedNow(task("task/acm-1"), head)).toBe(false);

    await git(path, "merge", "--squash", "task/acm-1");
    await git(path, "commit", "--quiet", "-m", "squashed");
    expect(await landedNow(task("task/acm-1"), head)).toBe(true);

    await git(path, "branch", "-D", "task/acm-1");
    expect(await landedNow(task("task/acm-1"), head)).toBe(true);
    expect(await landedNow(task("task/acm-1"), undefined)).toBe(false);
  });
});
