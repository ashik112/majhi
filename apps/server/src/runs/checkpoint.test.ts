import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git, tempDir } from "../testing/fixtures.ts";
import { type CheckpointRepo, commitCheckpoint, DEFAULT_IDENTITY, diffStat, diffText } from "./checkpoint.ts";

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

    const result = await commitCheckpoint([a, b], "ACM-1", 2, { name: "Acme Bot", email: "bot@acme.test" });
    expect(result).toEqual({ committed: ["api"], skipped: [] });
    expect(await git(a.worktree, "log", "-1", "--format=%s|%an|%ae")).toBe(
      "wip(ACM-1): checkpoint 2|Acme Bot|bot@acme.test",
    );
    expect(await git(a.worktree, "status", "--porcelain")).toBe("");
    expect(await git(b.worktree, "log", "-1", "--format=%s")).toBe("init");
  });

  it("does not commit a worktree that left the task branch", async () => {
    const a = await repo("api");
    await git(a.worktree, "checkout", "--quiet", "main");
    await writeFile(join(a.worktree, "x.txt"), "x");
    const result = await commitCheckpoint([a], "ACM-1", 1, DEFAULT_IDENTITY);
    expect(result.committed).toEqual([]);
    expect(result.skipped[0]).toContain("not on task/acm-1-fix (on main)");
  });

  it("reports the diff since the base, committed or not", async () => {
    const a = await repo("api");
    await writeFile(join(a.worktree, "one.ts"), "1\n");
    await commitCheckpoint([a], "ACM-1", 1, DEFAULT_IDENTITY);
    await writeFile(join(a.worktree, "README.md"), "# edited\n");
    const stat = await diffStat([a]);
    expect(stat).toContain("api:");
    expect(stat).toContain("one.ts");
    expect(stat).toContain("README.md");
    expect(await diffText([a], 10_000)).toContain("+# edited");
    expect((await diffText([a], 50)).length).toBeLessThanOrEqual(50);
  });
});
