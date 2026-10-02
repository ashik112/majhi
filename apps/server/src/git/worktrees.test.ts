import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir, git as testGit } from "../testing/fixtures.ts";
import { createWorktree, removeWorktree, repairWorktree, WorktreeProblem } from "./worktrees.ts";

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
    expect(result).toMatchObject({ createdBranch: true, warnings: [] });
    expect(result.startCommit).toBe(await testGit(wt("api"), "rev-parse", "HEAD"));
    expect(await readFile(join(wt("api"), "b.txt"), "utf8")).toBe("b\n");
    expect((await testGit(wt("api"), "symbolic-ref", "--short", "HEAD")).trim()).toBe("task/t-1-x");
    expect(await testGit(source, "symbolic-ref", "--short", "HEAD")).toBe("main");
    // No upstream, so nothing can be pushed by accident.
    await expect(testGit(wt("api"), "rev-parse", "--abbrev-ref", "task/t-1-x@{upstream}")).rejects.toThrow();
  });

  it("fails clearly when the branch is checked out in the source, and says when that checkout is dirty", async () => {
    await writeFile(join(source, "a.txt"), "changed\n");
    await expect(
      createWorktree({ source, base: "develop", branch: "main", path: wt("api") }),
    ).rejects.toThrow(
      `Branch "main" is already checked out at ${source}, which has uncommitted changes. Switch that checkout to another branch, or name a different working branch.`,
    );
  });

  it("never pushes: the remote is unchanged", async () => {
    const before = await testGit(remote, "for-each-ref");
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    await writeFile(join(wt("api"), "new.txt"), "n");
    expect(await testGit(remote, "for-each-ref")).toBe(before);
  });
});

describe("removing", () => {
  it("refuses a dirty worktree without force, and removes it with force", async () => {
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    await writeFile(join(wt("api"), "a.txt"), "edited\n");
    await expect(removeWorktree(source, wt("api"), false)).rejects.toBeInstanceOf(WorktreeProblem);
    expect((await stat(wt("api"))).isDirectory()).toBe(true);
    await removeWorktree(source, wt("api"), true);
    await expect(stat(wt("api"))).rejects.toThrow();
  });

  it("keeps a live task's entry when its folder is out of reach while another task's is removed", async () => {
    const live = join(dir, "tasks", "T-2", "api");
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    await createWorktree({ source, base: "develop", branch: "task/t-2-y", path: live });
    await rename(live, `${live}.away`);
    await removeWorktree(source, wt("api"), false);
    await rename(`${live}.away`, live);
    expect((await testGit(live, "symbolic-ref", "--short", "HEAD")).trim()).toBe("task/t-2-y");
    const listed = await testGit(source, "worktree", "list", "--porcelain");
    expect(listed).toContain(`worktree ${live}`);
    expect(listed).not.toContain(wt("api"));
  });
});

describe("repairWorktree", () => {
  const entryOf = async (path: string) =>
    (await readFile(join(path, ".git"), "utf8")).slice("gitdir: ".length).trim();

  it("leaves a healthy worktree alone", async () => {
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    expect(await repairWorktree(source, wt("api"), "task/t-1-x")).toEqual({ status: "fine" });
  });

  it("gives back a missing entry and keeps the files and uncommitted changes", async () => {
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    await writeFile(join(wt("api"), "a.txt"), "edited\n");
    await writeFile(join(wt("api"), "new.txt"), "new\n");
    const entry = await entryOf(wt("api"));
    await rm(entry, { recursive: true });
    await expect(testGit(wt("api"), "status")).rejects.toThrow();

    expect(await repairWorktree(source, wt("api"), "task/t-1-x")).toEqual({ status: "repaired", entry });
    expect((await testGit(wt("api"), "symbolic-ref", "--short", "HEAD")).trim()).toBe("task/t-1-x");
    const status = (await testGit(wt("api"), "status", "--porcelain")).split("\n").map((l) => l.trim());
    expect(status.sort()).toEqual(["?? new.txt", "M a.txt"]);
    expect(await testGit(source, "worktree", "list", "--porcelain")).toContain(`worktree ${wt("api")}`);
  });

  it("makes a new entry when the old name now belongs to another checkout", async () => {
    const other = join(dir, "tasks", "T-2", "api");
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    await createWorktree({ source, base: "develop", branch: "task/t-2-y", path: other });
    await rm(await entryOf(wt("api")), { recursive: true });
    // The freed name was taken by the next worktree git added.
    await writeFile(join(wt("api"), ".git"), `gitdir: ${await entryOf(other)}\n`);

    const result = await repairWorktree(source, wt("api"), "task/t-1-x");
    expect(result.status).toBe("repaired");
    expect((await testGit(wt("api"), "symbolic-ref", "--short", "HEAD")).trim()).toBe("task/t-1-x");
    expect((await testGit(other, "symbolic-ref", "--short", "HEAD")).trim()).toBe("task/t-2-y");
  });

  it("does not take a branch that is checked out somewhere else", async () => {
    await createWorktree({ source, base: "develop", branch: "task/t-1-x", path: wt("api") });
    await rm(await entryOf(wt("api")), { recursive: true });
    await testGit(source, "checkout", "--quiet", "task/t-1-x");
    expect(await repairWorktree(source, wt("api"), "task/t-1-x")).toMatchObject({ status: "skipped" });
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
});
