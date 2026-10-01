import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildEnv } from "@majhi/acp";
import { agentCommitter } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "../config/service.ts";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { attributionOf, ensureHooks, gitAttribution } from "./attribution.ts";

const run = promisify(execFile);

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

/** A repo with one commit, and a change to a.txt waiting to be committed by an agent. */
async function repoWithChange(): Promise<string> {
  const repo = join(dir, "api");
  await makeRepo(repo);
  await writeFile(join(repo, "a.txt"), "one\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "init");
  await writeFile(join(repo, "a.txt"), "two\n");
  return repo;
}

/** `git add` and `git commit` as a run of acme-dev on ACM-7 does them, with majhi's hooks in place. */
async function agentCommits(repo: string, ...flags: string[]): Promise<void> {
  const hooks = await ensureHooks(join(dir, "home"));
  const env = {
    ...buildEnv(
      { tool: "claude", home: dir },
      { PATH: process.env.PATH ?? "" },
      {
        author: { name: "Ada", email: "ada@acme.test" },
        committer: agentCommitter("acme-dev"),
        task: "ACM-7",
        hooks,
      },
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  await run("git", ["add", "."], { cwd: repo, env });
  await run("git", ["commit", "--quiet", ...flags, "-m", "feat: two"], { cwd: repo, env });
}

describe("an agent's own commit", () => {
  it("is authored as the org, committed by the agent, and linked to the task", async () => {
    const repo = await repoWithChange();
    // The repo's own hook still runs after majhi's.
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\ntouch hook-ran\n", {
      mode: 0o755,
    });
    await agentCommits(repo);

    expect(await git(repo, "log", "-1", "--format=%an|%ae|%cn|%ce")).toBe(
      "Ada|ada@acme.test|acme-dev via majhi|majhi@majhi.local",
    );
    expect(await git(repo, "log", "-1", "--format=%B")).toBe("feat: two\n\nMajhi-Task: ACM-7");
    expect(await git(repo, "status", "--porcelain", "--ignored")).toContain("hook-ran");
  });

  it("still runs the hooks of a repo that sets core.hooksPath, like husky", async () => {
    const repo = await repoWithChange();
    await mkdir(join(repo, ".husky"), { recursive: true });
    await writeFile(join(repo, ".husky", "pre-commit"), "#!/bin/sh\ntouch husky-ran\n", { mode: 0o755 });
    await git(repo, "config", "core.hooksPath", ".husky");
    await agentCommits(repo);

    expect(await git(repo, "status", "--porcelain", "--ignored")).toContain("husky-ran");
    expect(await git(repo, "log", "-1", "--format=%B")).toContain("Majhi-Task: ACM-7");
  });

  it("keeps the trailer under --no-verify, which skips only the repo's checks", async () => {
    const repo = await repoWithChange();
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await agentCommits(repo, "--no-verify");

    expect(await git(repo, "log", "-1", "--format=%cn|%B")).toContain("acme-dev via majhi|feat: two");
    expect(await git(repo, "log", "-1", "--format=%B")).toContain("Majhi-Task: ACM-7");
  });
});

/** Only what `attributionOf` reads from the config. */
function configWith(levels: {
  global?: boolean;
  org?: boolean;
  projects?: Record<string, boolean | undefined>;
}): ConfigService {
  const commits = (on: boolean | undefined) => (on === undefined ? undefined : { attribution: on });
  return {
    settings: async () => ({ commits: { attribution: levels.global ?? true } }),
    sections: async () => ({
      orgs: { acme: { name: "Acme", commits: commits(levels.org) } },
      projects: Object.fromEntries(
        Object.entries(levels.projects ?? {}).map(([id, on]) => [id, { org: "acme", commits: commits(on) }]),
      ),
    }),
  } as unknown as ConfigService;
}
const task = { id: "ACM-7", org: "acme", repos: [{ project: "api" }, { project: "web" }] };

describe("which repos are attributed", () => {
  it("follows the project, then the org, then majhi", async () => {
    const both = await attributionOf(
      configWith({ global: false, org: true, projects: { api: undefined, web: false } }),
      task,
    );
    expect(both).toEqual({ repos: { api: true, web: false }, run: false });
    expect(await attributionOf(configWith({ global: false }), task)).toEqual({
      repos: { api: false, web: false },
      run: false,
    });
    expect(await attributionOf(configWith({}), task)).toEqual({ repos: { api: true, web: true }, run: true });
  });

  it("turns a run off when any repo of the task is off, and decides a task with no repo by its org", async () => {
    const one = await attributionOf(configWith({ projects: { api: true, web: false } }), task);
    expect(one).toEqual({ repos: { api: true, web: false }, run: false });
    const none = await attributionOf(configWith({ org: false }), { org: "acme", repos: [] });
    expect(none.run).toBe(false);
  });

  it("gives a run with attribution off the org's identity and no hooks or task", async () => {
    const off = await gitAttribution(
      { config: configWith({ global: false }), majhiHome: join(dir, "home") },
      task,
      "acme-dev",
    );
    expect(off.hooks).toBeUndefined();
    expect(off.git.task).toBeUndefined();
    expect(off.git.committer).toEqual(off.git.author);
    const on = await gitAttribution(
      { config: configWith({}), majhiHome: join(dir, "home") },
      task,
      "acme-dev",
    );
    expect(on.git).toMatchObject({ committer: { name: "acme-dev via majhi" }, task: "ACM-7" });
    expect(on.hooks).toBe(join(dir, "home", "git-hooks"));
  });
});

describe("another task's branch", () => {
  /** A repo with task branches of ACM-1 and ACM-2, and git as a run of `task` would run it there. */
  async function twoTasks(): Promise<{ repo: string; as: (task?: string) => Record<string, string> }> {
    const repo = join(dir, "api");
    await makeRepo(repo, { commit: true });
    await git(repo, "branch", "task/acm-1-own-work");
    await git(repo, "branch", "task/acm-2-other-work");
    await git(repo, "branch", "task/acm-12-similar-id");
    const hooks = await ensureHooks(join(dir, "home"));
    const as = (task?: string) => ({
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: hooks,
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@acme.test",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@acme.test",
      ...(task === undefined ? {} : { MAJHI_TASK: task }),
    });
    return { repo, as };
  }

  /** `commit-tree` and `update-ref`, as the lead in the incident moved another task's branch. */
  async function updateRef(repo: string, env: Record<string, string>, branch: string): Promise<void> {
    const { stdout } = await run("git", ["commit-tree", "-p", "HEAD", "-m", "change", "HEAD^{tree}"], {
      cwd: repo,
      env,
    });
    await run("git", ["update-ref", `refs/heads/${branch}`, stdout.trim()], { cwd: repo, env });
  }

  it("refuses a raw update-ref from a run of another task, and points to change_task_branch", async () => {
    const { repo, as } = await twoTasks();
    const before = await git(repo, "rev-parse", "task/acm-2-other-work");
    const refused = updateRef(repo, as("ACM-1"), "task/acm-2-other-work");
    await expect(refused).rejects.toThrow(/another task \(ACM-2\).*change_task_branch/s);
    expect(await git(repo, "rev-parse", "task/acm-2-other-work")).toBe(before);
    // A task id that only starts the same is another task too.
    await expect(updateRef(repo, as("ACM-1"), "task/acm-12-similar-id")).rejects.toThrow(/ACM-12/);
    await expect(
      run("git", ["branch", "-D", "task/acm-2-other-work"], { cwd: repo, env: as("ACM-1") }),
    ).rejects.toThrow(/change_task_branch/);
  });

  it("refuses a commit in a worktree on another task's branch", async () => {
    const { repo, as } = await twoTasks();
    const other = join(dir, "other");
    await git(repo, "worktree", "add", "--quiet", other, "task/acm-2-other-work");
    await writeFile(join(other, "a.txt"), "two\n");
    await run("git", ["add", "."], { cwd: other, env: as("ACM-1") });
    await expect(
      run("git", ["commit", "--quiet", "--no-verify", "-m", "sneak"], { cwd: other, env: as("ACM-1") }),
    ).rejects.toThrow(/change_task_branch/);
    expect(await git(repo, "log", "-1", "--format=%s", "task/acm-2-other-work")).toBe("init");
  });

  it("allows the run's own branch, and anything without MAJHI_TASK", async () => {
    const { repo, as } = await twoTasks();
    await updateRef(repo, as("ACM-1"), "task/acm-1-own-work");
    expect(await git(repo, "log", "-1", "--format=%s", "task/acm-1-own-work")).toBe("change");
    await updateRef(repo, as(), "task/acm-2-other-work");
    expect(await git(repo, "log", "-1", "--format=%s", "task/acm-2-other-work")).toBe("change");
    // Branches that are not a task's stay free.
    await updateRef(repo, as("ACM-1"), "feature/x");
  });

  it("still runs the repo's own reference-transaction hook, with its input", async () => {
    const { repo, as } = await twoTasks();
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(
      join(repo, ".git", "hooks", "reference-transaction"),
      '#!/bin/sh\n[ "$1" = committed ] && cat >> "$(git rev-parse --git-common-dir)/seen"\nexit 0\n',
      { mode: 0o755 },
    );
    await updateRef(repo, as("ACM-1"), "task/acm-1-own-work");
    const seen = await readFile(join(repo, ".git", "seen"), "utf8");
    expect(seen).toContain("refs/heads/task/acm-1-own-work");
  });
});
