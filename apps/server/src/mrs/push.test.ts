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
  it("pushes to the URL it is given without changing the remote's own URL", async () => {
    const { dir, work, bare } = await repo();
    // The remote's URL points nowhere; only the URL given for this push works, as an SSH alias would.
    await git(work, "remote", "add", "origin", join(dir, "unreachable.git"));
    await pushBranch({ worktree: work, remote: "origin", branch: "task/x", url: bare });
    expect(await git(bare, "rev-parse", "refs/heads/task/x")).toBe(await git(work, "rev-parse", "HEAD"));
    expect(await git(work, "config", "remote.origin.url")).toBe(join(dir, "unreachable.git"));
    // The tracking branch moves as a push to the remote would move it.
    expect(await git(work, "rev-parse", "refs/remotes/origin/task/x")).toBe(
      await git(work, "rev-parse", "HEAD"),
    );
    expect(await readFile(join(work, ".git", "config"), "utf8")).not.toContain("pushurl");
  });

  it("sends the branch only to the URL it is given, not also to a pushurl the remote already has", async () => {
    const { dir, work, bare } = await repo();
    const other = join(dir, "other.git");
    await git(dir, "init", "--bare", "--quiet", "--initial-branch=main", other);
    await git(work, "remote", "add", "origin", join(dir, "unreachable.git"));
    await git(work, "config", "remote.origin.pushurl", other);
    await pushBranch({ worktree: work, remote: "origin", branch: "task/x", url: bare });
    expect(await git(bare, "rev-parse", "refs/heads/task/x")).toBe(await git(work, "rev-parse", "HEAD"));
    await expect(git(other, "rev-parse", "--verify", "refs/heads/task/x")).rejects.toThrow();
  });

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
