import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir, git as testGit } from "../testing/fixtures.ts";
import { defaultBranch, listFiles, uncommitted } from "./git.ts";
import {
  createWorktree,
  dirtyWorktrees,
  isSshAuthFailure,
  removeWorktree,
  WorktreeProblem,
} from "./worktrees.ts";

let dir: string;
let cleanup: () => Promise<void>;
let source: string;
let remote: string;

/** A source checkout on `main` with one commit, a branch `develop` one commit ahead, and a bare remote. */
async function setup(): Promise<void> {
  remote = join(dir, "remote.git");
  source = join(dir, "work", "api");
  await mkdir(remote, { recursive: true });
  await testGit(remote, "init", "--bare", "--quiet", "--initial-branch=main");
  await mkdir(source, { recursive: true });
  await testGit(source, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(source, "a.txt"), "a\n");
  await testGit(source, "add", ".");
  await testGit(source, "commit", "--quiet", "-m", "one");
  await testGit(source, "remote", "add", "origin", remote);
  await testGit(source, "checkout", "--quiet", "-b", "develop");
  await writeFile(join(source, "b.txt"), "b\n");
  await testGit(source, "add", ".");
  await testGit(source, "commit", "--quiet", "-m", "two");
  await testGit(source, "push", "--quiet", "origin", "main", "develop");
  await testGit(source, "checkout", "--quiet", "main");
}

beforeEach(async () => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  ({ dir, cleanup } = await tempDir());
  await setup();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

const wt = (name: string) => join(dir, "tasks", "T-1", name);

describe("createWorktree", () => {
  it("makes a new branch from the base and does not touch the source checkout", async () => {
    const result = await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    expect(result).toEqual({ createdBranch: true, warnings: [] });
    expect(await readFile(join(wt("api"), "b.txt"), "utf8")).toBe("b\n");
    expect((await testGit(wt("api"), "symbolic-ref", "--short", "HEAD")).trim()).toBe("task/t-1-x");
    expect(await testGit(source, "symbolic-ref", "--short", "HEAD")).toBe("main");
    // No upstream, so nothing can be pushed by accident.
    await expect(testGit(wt("api"), "rev-parse", "--abbrev-ref", "task/t-1-x@{upstream}")).rejects.toThrow();
  });

  it("fetches the base from the remote first", async () => {
    // Another clone pushes a new commit to develop.
    const other = join(dir, "other");
    await testGit(dir, "clone", "--quiet", remote, other);
    await testGit(other, "checkout", "--quiet", "develop");
    await writeFile(join(other, "c.txt"), "c\n");
    await testGit(other, "add", ".");
    await testGit(other, "commit", "--quiet", "-m", "three");
    await testGit(other, "push", "--quiet", "origin", "develop");

    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    expect(await readFile(join(wt("api"), "c.txt"), "utf8")).toBe("c\n");
  });

  it("warns and carries on when the fetch fails", async () => {
    await testGit(source, "remote", "set-url", "origin", join(dir, "gone.git"));
    const result = await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    expect(result.createdBranch).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(
      /^Could not fetch develop from origin \(.+\)\. Using the last copy on this machine\.$/,
    );
  });

  it("works in a repo with no remote", async () => {
    await testGit(source, "remote", "remove", "origin");
    const result = await createWorktree({ source, base: "main", branch: "task/t-1-x", path: wt("api") });
    expect(result).toEqual({ createdBranch: true, warnings: [] });
  });

  it("checks out an existing local branch", async () => {
    await testGit(source, "branch", "feat/x", "develop");
    const result = await createWorktree({ source, base: "main", branch: "feat/x", path: wt("api") });
    expect(result.createdBranch).toBe(false);
    expect(await readFile(join(wt("api"), "b.txt"), "utf8")).toBe("b\n");
  });

  it("checks out a branch that exists only on the remote, tracking it", async () => {
    await testGit(source, "push", "--quiet", "origin", "develop:refs/heads/feat/remote");
    const result = await createWorktree({ source, base: "main", branch: "feat/remote", path: wt("api") });
    expect(result.createdBranch).toBe(false);
    expect((await testGit(wt("api"), "rev-parse", "--abbrev-ref", "feat/remote@{upstream}")).trim()).toBe(
      "origin/feat/remote",
    );
  });

  it("fails clearly when the base does not exist", async () => {
    await expect(
      createWorktree({ source, base: "nope", branch: "task/t-1-x", path: wt("api") }),
    ).rejects.toThrow(`Base branch "nope" was not found in ${source}.`);
    await expect(stat(wt("api"))).rejects.toThrow();
  });

  it("fails clearly when the branch is checked out in the source, and says when that checkout is dirty", async () => {
    await writeFile(join(source, "a.txt"), "changed\n");
    await expect(
      createWorktree({ source, base: "develop", branch: "main", path: wt("api") }),
    ).rejects.toThrow(
      `Branch "main" is already checked out at ${source}, which has uncommitted changes. Switch that checkout to another branch, or name a different working branch.`,
    );
  });

  it("fails when the folder is in the way, and does nothing when it is already this worktree", async () => {
    await mkdir(wt("api"), { recursive: true });
    await writeFile(join(wt("api"), "keep.txt"), "x");
    await expect(
      createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") }),
    ).rejects.toBeInstanceOf(WorktreeProblem);

    await createWorktree({ source, base: "develop", branch: "task/t-1-y", path: wt("web") });
    const again = await createWorktree({ source, base: "develop", branch: "task/t-1-y", path: wt("web") });
    expect(again).toEqual({ createdBranch: false, warnings: [] });
  });

  it("fails for a folder that is not a git repo", async () => {
    await expect(
      createWorktree({ source: dir, base: "main", branch: "b/x", path: wt("api") }),
    ).rejects.toThrow("is not a git repo the server can see");
  });

  it("never pushes: the remote is unchanged", async () => {
    const before = await testGit(remote, "for-each-ref");
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    await writeFile(join(wt("api"), "new.txt"), "n");
    expect(await testGit(remote, "for-each-ref")).toBe(before);
  });
});

describe("removing", () => {
  it("reports dirty worktrees, including untracked files", async () => {
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    await createWorktree({ source, base: "develop", branch: "task/t-1-y", path: wt("web") });
    expect(await dirtyWorktrees([wt("api"), wt("web"), wt("missing")])).toEqual([]);
    await writeFile(join(wt("web"), "scratch.txt"), "x");
    expect(await dirtyWorktrees([wt("api"), wt("web")])).toEqual([
      { path: wt("web"), changes: ["?? scratch.txt"] },
    ]);
  });

  it("removes a clean worktree and its folder, and leaves the branch", async () => {
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    await removeWorktree(source, wt("api"), false);
    await expect(stat(wt("api"))).rejects.toThrow();
    expect(await testGit(source, "branch", "--list", "task/t-1-x")).toContain("task/t-1-x");
    expect(await testGit(source, "worktree", "list", "--porcelain")).not.toContain("t-1-x");
  });

  it("refuses a dirty worktree without force, and removes it with force", async () => {
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    await writeFile(join(wt("api"), "a.txt"), "edited\n");
    await expect(removeWorktree(source, wt("api"), false)).rejects.toBeInstanceOf(WorktreeProblem);
    expect((await stat(wt("api"))).isDirectory()).toBe(true);
    await removeWorktree(source, wt("api"), true);
    await expect(stat(wt("api"))).rejects.toThrow();
  });

  it("copes with a folder that is already gone", async () => {
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    const { rm } = await import("node:fs/promises");
    await rm(wt("api"), { recursive: true });
    await removeWorktree(source, wt("api"), false);
    expect(await testGit(source, "worktree", "list", "--porcelain")).not.toContain("t-1-x");
  });
});

describe("helpers", () => {
  it("finds the default branch from origin/HEAD, else the current branch", async () => {
    expect(await defaultBranch(source)).toBe("main");
    await testGit(source, "checkout", "--quiet", "develop");
    expect(await defaultBranch(source)).toBe("develop");
    await testGit(source, "remote", "set-head", "origin", "main");
    expect(await defaultBranch(source)).toBe("main");
  });

  it("lists tracked and untracked files but not ignored ones", async () => {
    await writeFile(join(source, ".gitignore"), "ignored.txt\n");
    await writeFile(join(source, "ignored.txt"), "x");
    await writeFile(join(source, "new.txt"), "x");
    expect((await listFiles(source)).sort()).toEqual([".gitignore", "a.txt", "new.txt"]);
    expect(await uncommitted(source)).toContain("?? new.txt");
  });
});

describe("fetch without SSH keys", () => {
  /**
   * Points origin at an ssh URL served by a fake ssh: it refuses with ssh's own "Permission
   * denied (publickey)" until the marker file exists (keys reloaded), then serves the bare
   * remote through git-upload-pack, like a real host would.
   */
  async function sshRemote(): Promise<{ marker: string }> {
    const marker = join(dir, "keys-loaded");
    const fakeSsh = join(dir, "fake-ssh.sh");
    await writeFile(
      fakeSsh,
      `#!/bin/sh\nif [ -f "${marker}" ]; then exec git-upload-pack "${remote}"; fi\n` +
        `echo "git@example.invalid: Permission denied (publickey)." >&2\nexit 255\n`,
    );
    await chmod(fakeSsh, 0o755);
    vi.stubEnv("GIT_SSH_COMMAND", fakeSsh);
    await testGit(source, "remote", "set-url", "origin", "ssh://git@example.invalid/api.git");
    return { marker };
  }

  it("reloads the owner's keys once and fetches again", async () => {
    const { marker } = await sshRemote();
    const reloadKeys = vi.fn(async () => {
      await writeFile(marker, "");
      return true;
    });
    const result = await createWorktree({
      source,
      base: "develop",
      branch: "task/t-1-x",
      path: wt("api"),
      reloadKeys,
    });
    expect(result.warnings).toEqual([]);
    expect(reloadKeys).toHaveBeenCalledTimes(1);
  });

  it("warns and uses the local copy when the keys cannot be reloaded", async () => {
    await sshRemote();
    const reloadKeys = vi.fn(async () => false);
    const result = await createWorktree({
      source,
      base: "develop",
      branch: "task/t-1-x",
      path: wt("api"),
      reloadKeys,
    });
    expect(reloadKeys).toHaveBeenCalledTimes(1);
    expect(result.warnings[0]).toMatch(/^Could not fetch develop from origin/);
    expect(await readFile(join(wt("api"), "b.txt"), "utf8")).toBe("b\n");
  });

  it("does not reload keys for failures that are not about SSH access", async () => {
    await testGit(source, "remote", "set-url", "origin", join(dir, "missing.git"));
    const reloadKeys = vi.fn(async () => true);
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api"), reloadKeys });
    expect(reloadKeys).not.toHaveBeenCalled();
  });

  it("recognizes ssh access failures", () => {
    expect(isSshAuthFailure("git@github.com: Permission denied (publickey).")).toBe(true);
    expect(isSshAuthFailure("Host key verification failed.")).toBe(true);
    expect(isSshAuthFailure("Could not resolve host: github.com")).toBe(false);
  });
});
