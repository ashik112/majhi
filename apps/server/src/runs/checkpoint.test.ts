import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git, tempDir } from "../testing/fixtures.ts";
import {
  type CheckpointRepo,
  commitBy,
  commitCheckpoint,
  DEFAULT_IDENTITY,
  MAX_NEW_FILES,
} from "./checkpoint.ts";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

async function repo(name: string, branch = "task/acm-1-fix"): Promise<CheckpointRepo> {
  const path = join(dir, name);
  await mkdir(path, { recursive: true });
  await git(path, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(path, "README.md"), "# r\n");
  await git(path, "add", ".");
  await git(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init");
  await git(path, "checkout", "--quiet", "-b", branch);
  return { project: name, worktree: path, branch, base: "main" };
}

describe("checkpoints", () => {
  it("commits changed worktrees on the task branch with the identity, and skips clean ones", async () => {
    const a = await repo("api");
    const b = await repo("web");
    await writeFile(join(a.worktree, "new.ts"), "export {};\n");
    await writeFile(join(a.worktree, "README.md"), "# changed\n");
    // A hook that would fail the commit must not run.
    await mkdir(join(a.worktree, ".git", "hooks"), { recursive: true });
    await writeFile(join(a.worktree, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    // The server's own git variables must not take the place of the author and the agent.
    vi.stubEnv("GIT_AUTHOR_NAME", "Someone Else");
    vi.stubEnv("GIT_COMMITTER_NAME", "Someone Else");
    const by = commitBy({ name: "Acme Bot", email: "bot@acme.test" }, "ACM-1", "acme-dev");
    const result = await commitCheckpoint([a, b], "ACM-1", 2, by);
    expect(result).toEqual({ committed: ["api"], skipped: [] });
    expect(await git(a.worktree, "log", "-1", "--format=%s|%an|%ae|%cn|%ce")).toBe(
      "wip(ACM-1): checkpoint 2|Acme Bot|bot@acme.test|acme-dev via majhi|majhi@majhi.local",
    );
    expect(await git(a.worktree, "log", "-1", "--format=%(trailers:key=Majhi-Task,valueonly)")).toBe("ACM-1");
    expect(await git(a.worktree, "status", "--porcelain")).toBe("");
    expect(await git(b.worktree, "log", "-1", "--format=%s")).toBe("init");
  });

  it("does not commit a worktree that left the task branch", async () => {
    const a = await repo("api");
    await git(a.worktree, "checkout", "--quiet", "main");
    await writeFile(join(a.worktree, "x.txt"), "x");
    const result = await commitCheckpoint([a], "ACM-1", 1, commitBy(DEFAULT_IDENTITY, "ACM-1"));
    expect(result.committed).toEqual([]);
    expect(result.skipped[0]).toContain("not on task/acm-1-fix (on main)");
  });

  it("never commits a cache folder of thousands of new files", async () => {
    const a = await repo("api");
    await mkdir(join(a.worktree, ".store"), { recursive: true });
    await Promise.all(
      Array.from({ length: MAX_NEW_FILES + 1 }, (_, i) =>
        writeFile(join(a.worktree, ".store", `f${i}`), "x"),
      ),
    );
    const result = await commitCheckpoint([a], "ACM-1", 1, commitBy(DEFAULT_IDENTITY, "ACM-1"));
    expect(result.committed).toEqual([]);
    expect(result.skipped[0]).toContain(".store");
    expect(await git(a.worktree, "log", "-1", "--format=%s")).toBe("init");
    expect(await git(a.worktree, "diff", "--cached", "--name-only")).toBe("");
  });

});
