import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReposResponse, RootScan } from "@majhi/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { RepoScanner, type ScanRequest, scanWorkspaces } from "./scanner.ts";

describe("scanWorkspaces", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let root: string;
  let home: string;
  let result: ReposResponse;
  const runningAsRoot = process.getuid?.() === 0;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
    root = join(dir, "Work");
    home = join(dir, "home");
    await mkdir(join(home, ".ssh"), { recursive: true });
    await writeFile(
      join(home, ".ssh", "config"),
      [
        "Host github-acme",
        "  HostName github.com",
        "  IdentityFile ~/.ssh/acme",
        "",
        "Host gitlab-work other-alias",
        "  HostName=gitlab.example.dev",
        "",
        "Host *",
        "  AddKeysToAgent yes",
      ].join("\n"),
    );

    await makeRepo(join(root, "alpha"), {
      remotes: { origin: "git@github.com:acme/alpha.git" },
      commit: true,
    });
    await makeRepo(join(root, "clients/acme/api"), {
      remotes: { origin: "https://gitlab.com/acme/api.git" },
      branch: "develop",
    });
    await makeRepo(join(root, "clients/acme/api/nested"));
    await makeRepo(join(root, "bitbucket"), { remotes: { origin: "ssh://git@bitbucket.org:22/acme/b.git" } });
    await makeRepo(join(root, "aliased"), { remotes: { origin: "git@github-acme:acme/aliased.git" } });
    await makeRepo(join(root, "other"), {
      remotes: { origin: "https://git.example.com/x.git", upstream: "gitlab-work:acme/o.git" },
    });
    await makeRepo(join(root, "a/b/c/d"));
    await makeRepo(join(root, "a/b/c/d2/e"));
    await makeRepo(join(root, "web/node_modules/pkg"));
    await makeRepo(join(root, ".hidden/secret"));
    await makeRepo(join(root, "tasks/t-1/repo"));
    await git(join(root, "alpha"), "worktree", "add", "--quiet", join(root, "alpha-wt"));
    await symlink(root, join(root, "loop"));
    await symlink(join(root, "alpha"), join(root, "alpha-link"));
    await mkdir(join(root, "locked/inside"), { recursive: true });
    await chmod(join(root, "locked"), 0o000);
    await writeFile(join(dir, "a-file"), "");

    result = await scanWorkspaces({
      config: {
        workspaces: [root, join(dir, "missing"), join(dir, "a-file")],
        tasksDir: join(root, "tasks"),
      },
      projectPaths: [join(root, "alpha")],
      hostHome: home,
    });
  });

  afterAll(async () => {
    await chmod(join(root, "locked"), 0o755);
    await cleanup();
  });

  const work = (): RootScan => {
    const scan = result.roots[0];
    if (!scan) throw new Error("no scan for the first root");
    return scan;
  };
  const repo = (relPath: string) => work().repos.find((r) => r.relPath === relPath);

  it("finds nested repos up to 4 levels deep, sorted, skipping what it should", () => {
    expect(work().mounted).toBe(true);
    expect(work().repos.map((r) => r.relPath)).toEqual([
      "a/b/c/d",
      "aliased",
      "alpha",
      "bitbucket",
      "clients/acme/api",
      "other",
    ]);
  });

  it("reads the branch and marks registered projects", () => {
    expect(repo("alpha")).toMatchObject({
      name: "alpha",
      path: join(root, "alpha"),
      branch: "main",
      registered: true,
    });
    expect(repo("clients/acme/api")).toMatchObject({ name: "api", branch: "develop", registered: false });
  });

  it("classifies remote hosts and resolves ssh aliases", () => {
    expect(repo("alpha")?.remotes).toEqual([
      { name: "origin", url: "git@github.com:acme/alpha.git", host: "github" },
    ]);
    expect(repo("clients/acme/api")?.remotes[0]?.host).toBe("gitlab");
    expect(repo("bitbucket")?.remotes[0]?.host).toBe("bitbucket");
    expect(repo("aliased")?.remotes).toEqual([
      { name: "origin", url: "git@github-acme:acme/aliased.git", host: "github", sshAlias: "github-acme" },
    ]);
    expect(repo("other")?.remotes).toEqual([
      { name: "origin", url: "https://git.example.com/x.git", host: "other" },
      { name: "upstream", url: "gitlab-work:acme/o.git", host: "gitlab", sshAlias: "gitlab-work" },
    ]);
  });

  it.skipIf(runningAsRoot)("records unreadable folders and keeps going", () => {
    expect(work().error).toBe("Could not read 1 folder: locked: permission denied");
  });

  it("reports roots that are missing or not folders as not mounted", () => {
    expect(result.roots[1]).toEqual({ path: join(dir, "missing"), mounted: false, repos: [] });
    expect(result.roots[2]).toMatchObject({ path: join(dir, "a-file"), mounted: false, repos: [] });
  });
});

describe("RepoScanner", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterAll(() => cleanup());

  it("reuses the last scan until asked to refresh or the config changes", async () => {
    const scanner = new RepoScanner();
    const request: ScanRequest = {
      config: { workspaces: [dir], tasksDir: join(dir, ".majhi") },
      projectPaths: [],
      hostHome: dir,
    };
    await makeRepo(join(dir, "one"));
    const first = await scanner.scan(request, false);
    await makeRepo(join(dir, "two"));

    expect(await scanner.scan(request, false)).toBe(first);
    const refreshed = await scanner.scan(request, true);
    expect(refreshed.roots[0]?.repos.map((r) => r.name)).toEqual(["one", "two"]);

    const registered = await scanner.scan({ ...request, projectPaths: [join(dir, "two")] }, false);
    expect(registered).not.toBe(refreshed);
    expect(registered.roots[0]?.repos.map((r) => r.registered)).toEqual([false, true]);
  });
});
