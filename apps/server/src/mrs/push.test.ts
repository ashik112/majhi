import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, tempDir } from "../testing/fixtures.ts";
import { PushProblem, pushBranch } from "./push.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup?.();
});

async function repo() {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  const t = await tempDir();
  cleanup = t.cleanup;
  const work = join(t.dir, "work");
  const bare = join(t.dir, "host.git");
  await mkdir(work, { recursive: true });
  await git(t.dir, "init", "--bare", "--quiet", "--initial-branch=main", bare);
  await git(work, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(work, "a.txt"), "a\n");
  await git(work, "add", ".");
  await git(work, "commit", "--quiet", "-m", "init");
  await git(work, "checkout", "--quiet", "-b", "task/x");
  await writeFile(join(work, "b.txt"), "b\n");
  await git(work, "add", ".");
  await git(work, "commit", "--quiet", "-m", "work");
  return { dir: t.dir, work, bare };
}

describe("pushBranch", () => {
  it("never forces: a diverged branch is refused", async () => {
    const { work, bare } = await repo();
    await git(work, "remote", "add", "origin", bare);
    await pushBranch({ worktree: work, remote: "origin", branch: "task/x" });
    await git(work, "reset", "--quiet", "--hard", "main");
    await writeFile(join(work, "c.txt"), "c\n");
    await git(work, "add", ".");
    await git(work, "commit", "--quiet", "-m", "other work");
    await expect(pushBranch({ worktree: work, remote: "origin", branch: "task/x" })).rejects.toBeInstanceOf(
      PushProblem,
    );
  });
});
