import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRepo } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { guardMounts } from "../runs/launch.ts";
import { typeOfBranch } from "./branch-naming.ts";
import { targetRefusal } from "./ship-plan.ts";
import { unshippedCommits } from "./shipped.ts";

describe("branches that already exist", () => {
  it("leaves task/ branches alone: no type, still guarded", async () => {
    expect(typeOfBranch("task/acm-1-fix-login")).toBeUndefined();
    expect(typeOfBranch("fix/acm-1-fix-login")).toBe("fix");
    expect(typeOfBranch("feature/acm-1-x")).toBe("feat");
    expect(typeOfBranch("main")).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "majhi-guard-"));
    try {
      const paths = async (branch: string, created: boolean) =>
        (await guardMounts(dir, branch, created)).map(
          (m) => `${m.path.slice(dir.length)}${m.readOnly === true ? " ro" : ""}`,
        );
      expect(await paths("task/acm-1-fix-login", false)).toEqual([
        "/refs/heads ro",
        "/refs/heads/task",
        "/refs/remotes ro",
        "/refs/tags ro",
      ]);
      expect(await paths("fix/acm-1-fix-login", true)).toEqual([
        "/refs/heads ro",
        "/refs/heads/fix",
        "/refs/remotes ro",
        "/refs/tags ro",
      ]);
      expect(await paths("feature/acm-1-login", true)).toContain("/refs/heads/feature");
      // A branch the owner named stays writable: only the hooks guard it.
      expect(await paths("dev", false)).toEqual([]);
      expect(await paths("owner/topic", false)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to ship into any task's branch, old or new", async () => {
    const repo = { project: "acme-api", base: "main", branch: "feat/acm-1-x" } as TaskRepo;
    expect(await targetRefusal(repo, "task/acm-2-y", "/tasks")).toContain("is a task branch");
    expect(await targetRefusal(repo, "fix/acm-2-y", "/nonexistent", new Set(["fix/acm-2-y"]))).toContain(
      "is a task branch",
    );
  });

  it("does not count a task's work as shipped because another task's branch stacks on it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "majhi-ship-"));
    try {
      const run = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
          cwd: dir,
          stdio: "pipe",
        });
      run("init", "--quiet", "-b", "main");
      run("commit", "--quiet", "--allow-empty", "-m", "base");
      run("checkout", "--quiet", "-b", "feat/acm-1-a");
      run("commit", "--quiet", "--allow-empty", "-m", "work");
      run("branch", "fix/acm-2-b");
      run("checkout", "--quiet", "main");
      const repo = {
        project: "acme-api",
        source: dir,
        base: "main",
        branch: "feat/acm-1-a",
        createdBranch: true,
      } as TaskRepo;
      expect(await unshippedCommits(repo, new Set(["feat/acm-1-a", "fix/acm-2-b"]))).toBe(1);
      expect(await unshippedCommits(repo, new Set(["feat/acm-1-a"]))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
