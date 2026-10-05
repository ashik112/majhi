import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir, git as testGit } from "../testing/fixtures.ts";
import { syncBranch } from "./worktrees.ts";

/** Bringing a fetched base into a task branch: real repos, no network. `base` stands in for origin/main. */

let dir: string;
let cleanup: () => Promise<void>;
let source: string;
let worktree: string;
const identity = { name: "Acme Bot", email: "bot@example.com" };

const head = async (cwd = worktree) => (await testGit(cwd, "rev-parse", "HEAD")).trim();
const commit = async (cwd: string, file: string, text: string, msg: string) => {
  await writeFile(join(cwd, file), text);
  await testGit(cwd, "add", ".");
  await testGit(
    cwd,
    "-c",
    "user.name=Other",
    "-c",
    "user.email=o@example.com",
    "commit",
    "--quiet",
    "-m",
    msg,
  );
};
const sync = (pushed: boolean) =>
  syncBranch({ worktree, branch: "task/t-1", upstream: "base", pushed, identity });

beforeEach(async () => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  ({ dir, cleanup } = await tempDir());
  source = join(dir, "api");
  worktree = join(dir, "tasks", "T-1", "api");
  await mkdir(source, { recursive: true });
  await testGit(source, "init", "--quiet", "--initial-branch=base");
  await commit(source, "a.txt", "a\n", "one");
  await mkdir(join(dir, "tasks", "T-1"), { recursive: true });
  await testGit(source, "worktree", "add", "--quiet", "-b", "task/t-1", worktree, "base");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

describe("syncBranch", () => {
  it("is a no-op when the branch already has the base", async () => {
    await commit(worktree, "mine.txt", "m\n", "mine");
    const before = await head();
    expect(await sync(false)).toEqual({ status: "current", from: before, to: before });
    expect(await head()).toBe(before);
  });

  it("fast-forwards a branch with no commits of its own", async () => {
    await commit(source, "b.txt", "b\n", "base moves");
    const tip = await head(source);
    const out = await sync(true);
    expect(out).toMatchObject({ status: "fast-forwarded", to: tip });
    expect(await head()).toBe(tip);
  });

  it("rebases a branch that was never pushed", async () => {
    await commit(worktree, "mine.txt", "m\n", "mine");
    await commit(source, "b.txt", "b\n", "base moves");
    const baseTip = await head(source);
    const out = await sync(false);
    expect(out.status).toBe("rebased");
    expect((await testGit(worktree, "rev-list", "--merges", "--count", "HEAD")).trim()).toBe("0");
    expect(await testGit(worktree, "merge-base", "--is-ancestor", baseTip, "HEAD").then(() => true)).toBe(
      true,
    );
    expect(await readFile(join(worktree, "mine.txt"), "utf8")).toBe("m\n");
  });

  it("merges a pushed branch, keeping its commits so no force push is needed", async () => {
    await commit(worktree, "mine.txt", "m\n", "mine");
    const pushedTip = await head();
    await commit(source, "b.txt", "b\n", "base moves");
    const out = await sync(true);
    expect(out).toMatchObject({ status: "merged", from: pushedTip });
    // The old tip is an ancestor of the new one: a plain push is enough.
    await testGit(worktree, "merge-base", "--is-ancestor", pushedTip, "HEAD");
    expect((await testGit(worktree, "log", "-1", "--format=%an <%ae>")).trim()).toBe(
      "Acme Bot <bot@example.com>",
    );
  });

  it("refuses a dirty worktree and leaves it untouched", async () => {
    await commit(source, "b.txt", "b\n", "base moves");
    await writeFile(join(worktree, "a.txt"), "edited\n");
    await writeFile(join(worktree, "new.txt"), "new\n");
    const before = await head();
    const out = await sync(false);
    expect(out).toEqual({ status: "refused", reason: "it has uncommitted changes" });
    expect(await head()).toBe(before);
    expect(await readFile(join(worktree, "a.txt"), "utf8")).toBe("edited\n");
    expect(await readFile(join(worktree, "new.txt"), "utf8")).toBe("new\n");
  });

  it.each([false, true])(
    "on a conflict (pushed %s) leaves the branch and worktree as they were",
    async (pushed) => {
      await commit(worktree, "a.txt", "mine\n", "mine");
      await commit(source, "a.txt", "theirs\n", "theirs");
      const before = await head();
      const out = await sync(pushed);
      expect(out.status).toBe("refused");
      expect(out.status === "refused" && out.reason).toContain("a.txt");
      expect(await head()).toBe(before);
      expect((await testGit(worktree, "status", "--porcelain")).trim()).toBe("");
      expect((await testGit(worktree, "symbolic-ref", "--short", "HEAD")).trim()).toBe("task/t-1");
      expect(await readFile(join(worktree, "a.txt"), "utf8")).toBe("mine\n");
      await expect(testGit(worktree, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")).rejects.toThrow();
    },
  );
});
