import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git as plainGit } from "../testing/fixtures.ts";
import { git, localBranchExists, remoteBranchExists } from "./git.ts";
import { refExists } from "./refs.ts";

/** What git itself says, to hold the file reader to. */
async function gitSays(cwd: string, ref: string): Promise<boolean> {
  return git(cwd, ["show-ref", "--verify", "--quiet", ref]).then(
    () => true,
    () => false,
  );
}

describe("whether a ref exists, read from git's files", () => {
  let dir: string;
  let repo: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-refs-"));
    repo = join(dir, "repo");
    await mkdir(repo);
    await plainGit(repo, "init", "--quiet", "--initial-branch=main");
    await plainGit(repo, "commit", "--quiet", "--allow-empty", "-m", "init");
    await plainGit(repo, "branch", "feat/one");
    await plainGit(repo, "branch", "plain");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const refs = [
    "refs/heads/main",
    "refs/heads/feat/one",
    "refs/heads/feat",
    "refs/heads/feat/one/deeper",
    "refs/heads/plain",
    "refs/heads/missing",
    "refs/heads/MAIN-not",
    "refs/remotes/origin/main",
  ];

  it("agrees with git for loose refs", async () => {
    for (const ref of refs) expect(await refExists(repo, ref), ref).toBe(await gitSays(repo, ref));
  });

  it("agrees with git after the refs are packed", async () => {
    await plainGit(repo, "pack-refs", "--all");
    for (const ref of refs) expect(await refExists(repo, ref), ref).toBe(await gitSays(repo, ref));
    expect(await refExists(repo, "refs/heads/plain")).toBe(true);
  });

  it("agrees with git from a linked worktree", async () => {
    const tree = join(dir, "tree");
    await plainGit(repo, "worktree", "add", "--quiet", "-b", "topic", tree);
    for (const ref of [...refs, "refs/heads/topic"]) {
      expect(await refExists(tree, ref), ref).toBe(await gitSays(tree, ref));
    }
  });

  it("agrees with git for a remote branch", async () => {
    const remote = join(dir, "remote.git");
    await plainGit(dir, "init", "--bare", "--quiet", "--initial-branch=main", remote);
    await plainGit(repo, "remote", "add", "origin", remote);
    await plainGit(repo, "push", "--quiet", "origin", "main");
    await plainGit(repo, "fetch", "--quiet", "origin");
    expect(await remoteBranchExists(repo, "origin", "main")).toBe(true);
    expect(await remoteBranchExists(repo, "origin", "nope")).toBe(false);
    expect(await localBranchExists(repo, "feat/one")).toBe(true);
  });

  it("leaves what it cannot read to git", async () => {
    const bare = join(dir, "bare.git");
    await plainGit(dir, "init", "--bare", "--quiet", bare);
    expect(await refExists(bare, "refs/heads/main")).toBeUndefined();
    expect(await refExists(repo, "refs/heads/../../config")).toBeUndefined();
    expect(await refExists(repo, "HEAD")).toBeUndefined();
    await mkdir(join(repo, "sub"));
    expect(await refExists(join(repo, "sub"), "refs/heads/main")).toBeUndefined();
    await writeFile(join(repo, ".git", "refs", "heads", "odd"), "ref: refs/heads/main\n");
    expect(await refExists(repo, "refs/heads/odd")).toBeUndefined();
    expect(await localBranchExists(repo, "odd")).toBe(await gitSays(repo, "refs/heads/odd"));
  });
});
