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
