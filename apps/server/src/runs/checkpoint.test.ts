import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorktree } from "../git/worktrees.ts";
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

  describe("in a task worktree", () => {
    /** The owner's checkout, with `tracked` files committed on main, and a task worktree cut from it. */
    async function taskWorktree(
      tracked: Record<string, string> = {},
      task = "ACM-1",
    ): Promise<{
      source: string;
      repo: CheckpointRepo;
    }> {
      const source = join(dir, "owner", task, "api");
      await mkdir(source, { recursive: true });
      await git(source, "init", "--quiet", "--initial-branch=main");
      await writeFile(join(source, "README.md"), "# r\n");
      for (const [file, text] of Object.entries(tracked)) {
        await mkdir(join(source, file, ".."), { recursive: true });
        await writeFile(join(source, file), text);
      }
      await git(source, "add", ".");
      await git(source, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init");
      const path = join(dir, "tasks", task, "api");
      await createWorktree({ source, base: "main", branch: "task/acm-1-fix", path });
      return { source, repo: { project: "api", worktree: path, branch: "task/acm-1-fix", base: "main" } };
    }
    const by = commitBy(DEFAULT_IDENTITY, "ACM-1");

    it("never commits a package store or node_modules, even far under the file limit", async () => {
      const { repo: a } = await taskWorktree();
      for (const file of [
        ".pnpm-store/v11/index.db",
        "node_modules/left-pad/index.js",
        "web/node_modules/x/y.js",
      ]) {
        await mkdir(join(a.worktree, file, ".."), { recursive: true });
        await writeFile(join(a.worktree, file), "x");
      }
      await writeFile(join(a.worktree, "feature.ts"), "export {};\n");
      expect(await commitCheckpoint([a], "ACM-1", 1, by)).toEqual({ committed: ["api"], skipped: [] });
      expect((await git(a.worktree, "show", "--name-only", "--format=", "HEAD")).split("\n")).toEqual([
        "feature.ts",
      ]);
    });

    it("keeps committing a folder the repo tracks, new files included", async () => {
      const { repo: a } = await taskWorktree({
        "node_modules/kept/index.js": "1",
        "coverage/lcov.info": "1",
      });
      await writeFile(join(a.worktree, "node_modules/kept/index.js"), "2");
      await writeFile(join(a.worktree, "node_modules/kept/more.js"), "3");
      await writeFile(join(a.worktree, "coverage/new.info"), "4");
      await mkdir(join(a.worktree, ".venv"), { recursive: true });
      await writeFile(join(a.worktree, ".venv/pyvenv.cfg"), "5");
      expect(await commitCheckpoint([a], "ACM-1", 1, by)).toEqual({ committed: ["api"], skipped: [] });
      expect((await git(a.worktree, "show", "--name-only", "--format=", "HEAD")).split("\n").sort()).toEqual([
        "coverage/new.info",
        "node_modules/kept/index.js",
        "node_modules/kept/more.js",
      ]);
    });

    it("leaves the owner's checkout alone", async () => {
      const { source, repo: a } = await taskWorktree();
      const exclude = join(source, ".git", "info", "exclude");
      const before = await readFile(exclude, "utf8");
      await mkdir(join(a.worktree, "node_modules"), { recursive: true });
      await writeFile(join(a.worktree, "node_modules/x.js"), "x");
      await commitCheckpoint([a], "ACM-1", 1, by);
      await mkdir(join(source, "node_modules"), { recursive: true });
      await writeFile(join(source, "node_modules/x.js"), "x");
      expect(await readFile(exclude, "utf8")).toBe(before);
      expect(await git(source, "config", "--local", "--get-all", "core.excludesFile").catch(() => "")).toBe(
        "",
      );
      expect(await git(source, "status", "--porcelain")).toBe("?? node_modules/");
    });

    it("excludes target only for a Rust or Java repo", async () => {
      const plain = await taskWorktree();
      const rust = await taskWorktree({ "Cargo.toml": "[package]\n" }, "ACM-2");
      for (const { repo: r } of [plain, rust]) {
        await mkdir(join(r.worktree, "target"), { recursive: true });
        await writeFile(join(r.worktree, "target/notes.md"), "x");
        await writeFile(join(r.worktree, "feature.ts"), "export {};\n");
      }
      await commitCheckpoint([plain.repo, rust.repo], "ACM-1", 1, by);
      expect(
        (await git(plain.repo.worktree, "show", "--name-only", "--format=", "HEAD")).split("\n").sort(),
      ).toEqual(["feature.ts", "target/notes.md"]);
      expect(await git(rust.repo.worktree, "show", "--name-only", "--format=", "HEAD")).toBe("feature.ts");
    });
  });
});
