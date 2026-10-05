import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { configIsPlain, repoConfigIsPlain } from "./repo-config.ts";

describe("the fast look at a repo's config", () => {
  it("passes a plain config", () => {
    expect(
      configIsPlain(
        '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = /x/y.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n',
      ),
    ).toBe(true);
  });

  it.each([
    ["a clean filter", '[filter "x"]\n\tclean = evil'],
    ["a smudge filter in any case", '[Filter "x"]\n\tSMUDGE = evil'],
    ["a merge driver", '[merge "x"]\n\tdriver = evil'],
    ["a credential helper", "[credential]\n\thelper = evil"],
    ["a url credential helper", '[credential "https://a.test"]\n\thelper = evil'],
    ["an upload pack", '[remote "origin"]\n\tuploadpack = evil'],
    ["askpass", "[core]\n\taskpass = evil"],
    ["a git proxy", "[core]\n\tgitProxy = evil"],
    ["a gpg program", "[gpg]\n\tprogram = evil"],
    ["a gpg ssh program", '[gpg "ssh"]\n\tprogram = evil'],
    ["a legacy subsection", "[gpg.ssh]\n\tprogram = evil"],
    ["signing on", "[commit]\n\tgpgsign = true"],
    ["a key on the header line", "[core] askpass = evil"],
    ["an include", "[include]\n\tpath = /elsewhere"],
    ["a conditional include", '[includeIf "gitdir:/x/"]\n\tpath = /elsewhere'],
    ["a value that continues on the next line", '[core]\n\tpager = a \\\n[filter "x"]\n'],
    ["a line it cannot read", "[core]\n\tthis is not config"],
    ["a key before any section", "askpass = evil"],
  ])("does not pass %s", (_name, text) => {
    expect(configIsPlain(text)).toBe(false);
  });
});

describe("a repo and its worktrees", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-repo-config-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const make = async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    await git(repo, "init", "--quiet", "--initial-branch=main");
    await git(repo, "commit", "--quiet", "--allow-empty", "-m", "init");
    return repo;
  };

  it("passes a plain repo and a worktree of it", async () => {
    const repo = await make();
    const tree = join(dir, "tree");
    await git(repo, "worktree", "add", "--quiet", "-b", "feat", tree);
    expect(await repoConfigIsPlain(repo, {})).toBe(true);
    expect(await repoConfigIsPlain(tree, {})).toBe(true);
  });

  it("sees a command planted in the repo's config, from the repo and from its worktree", async () => {
    const repo = await make();
    const tree = join(dir, "tree");
    await git(repo, "worktree", "add", "--quiet", "-b", "feat", tree);
    await appendFile(join(repo, ".git", "config"), '[filter "x"]\n\tclean = evil\n');
    expect(await repoConfigIsPlain(repo, {})).toBe(false);
    expect(await repoConfigIsPlain(tree, {})).toBe(false);
  });

  it("sees a command planted in a worktree's own config", async () => {
    const repo = await make();
    const tree = join(dir, "tree");
    await git(repo, "worktree", "add", "--quiet", "-b", "feat", tree);
    const gitdir = (await git(tree, "rev-parse", "--absolute-git-dir")).trim();
    await writeFile(join(gitdir, "config.worktree"), "[core]\n\taskpass = evil\n");
    expect(await repoConfigIsPlain(tree, {})).toBe(false);
  });

  it("does not answer for a subfolder, a bare repo or a pointed-at git dir", async () => {
    const repo = await make();
    await mkdir(join(repo, "sub"));
    const bare = join(dir, "bare.git");
    await git(dir, "init", "--bare", "--quiet", bare);
    expect(await repoConfigIsPlain(join(repo, "sub"), {})).toBe(false);
    expect(await repoConfigIsPlain(bare, {})).toBe(false);
    expect(await repoConfigIsPlain(repo, { GIT_DIR: join(dir, "other") })).toBe(false);
  });
});
