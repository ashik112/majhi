import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildEnv } from "@majhi/acp";
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

/**
 * The owner's repo `api`, checked out on `develop`, with `main` and the worktree of ACM-7 on its own
 * branch `task/acm-7-work`, holding a change to a.txt. A run works there, never in the checkout.
 */
async function taskWorktree(): Promise<{ repo: string; wt: string }> {
  const repo = join(dir, "api");
  await makeRepo(repo);
  await writeFile(join(repo, "a.txt"), "one\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "init");
  await git(repo, "checkout", "--quiet", "-b", "develop");
  const wt = join(dir, "ACM-7", "api");
  await git(repo, "worktree", "add", "--quiet", "-b", "task/acm-7-work", wt, "main");
  await writeFile(join(wt, "a.txt"), "two\n");
  return { repo, wt };
}

/** The environment of a run of acme-dev on ACM-7, as majhi builds it from the config. */
async function runEnv(
  repo: string,
  options: { attribution?: boolean; branch?: string } = {},
): Promise<Record<string, string>> {
  const attribution = await gitAttribution(
    { config: configWith({ global: options.attribution ?? true }), majhiHome: join(dir, "home") },
    {
      id: "ACM-7",
      org: "acme",
      repos: [{ project: "api", branch: options.branch ?? "task/acm-7-work", source: repo }],
    },
    "acme-dev",
  );
  return {
    ...buildEnv({ tool: "claude", home: dir }, { PATH: process.env.PATH ?? "" }, attribution.git),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** `git add` and `git commit` as a run of acme-dev on ACM-7 does them, with majhi's hooks in place. */
async function agentCommits(repo: string, wt: string, ...flags: string[]): Promise<void> {
  const env = await runEnv(repo);
  await run("git", ["add", "."], { cwd: wt, env });
  await run("git", ["commit", "--quiet", ...flags, "-m", "feat: two"], { cwd: wt, env });
}

describe("an agent's own commit", () => {
  it("is authored as the org, committed by the agent, and linked to the task", async () => {
    const { repo, wt } = await taskWorktree();
    // The repo's own hook still runs after majhi's.
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\ntouch hook-ran\n", {
      mode: 0o755,
    });
    await agentCommits(repo, wt);

    expect(await git(wt, "log", "-1", "--format=%an|%ae|%cn|%ce")).toBe(
      "Ada|ada@acme.test|acme-dev via majhi|majhi@majhi.local",
    );
    expect(await git(wt, "log", "-1", "--format=%B")).toBe("feat: two\n\nMajhi-Task: ACM-7");
    expect(await git(wt, "status", "--porcelain", "--ignored")).toContain("hook-ran");
  });

  it("still runs the hooks of a repo that sets core.hooksPath, like husky", async () => {
    const { repo, wt } = await taskWorktree();
    await mkdir(join(wt, ".husky"), { recursive: true });
    await writeFile(join(wt, ".husky", "pre-commit"), "#!/bin/sh\ntouch husky-ran\n", { mode: 0o755 });
    await git(repo, "config", "core.hooksPath", ".husky");
    await agentCommits(repo, wt);

    expect(await git(wt, "status", "--porcelain", "--ignored")).toContain("husky-ran");
    expect(await git(wt, "log", "-1", "--format=%B")).toContain("Majhi-Task: ACM-7");
  });

  it("keeps the trailer under --no-verify, which skips only the repo's checks", async () => {
    const { repo, wt } = await taskWorktree();
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await agentCommits(repo, wt, "--no-verify");

    expect(await git(wt, "log", "-1", "--format=%cn|%B")).toContain("acme-dev via majhi|feat: two");
    expect(await git(wt, "log", "-1", "--format=%B")).toContain("Majhi-Task: ACM-7");
  });

  it("with attribution off has no trailer and the org as committer, and still stays on its branch", async () => {
    const { repo, wt } = await taskWorktree();
    const env = await runEnv(repo, { attribution: false });
    await run("git", ["commit", "--quiet", "-am", "feat: two"], { cwd: wt, env });
    expect(await git(wt, "log", "-1", "--format=%cn|%B")).toBe("Ada|feat: two");
    await expect(run("git", ["branch", "-f", "main", "HEAD"], { cwd: wt, env })).rejects.toThrow(
      /main is not a branch of ACM-7/,
    );
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
      orgs: {
        acme: {
          name: "Acme",
          identity: { name: "Ada", email: "ada@acme.test" },
          commits: commits(levels.org),
        },
      },
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

  it("gives a run with attribution off the org's identity and no trailer, but still the hooks and task", async () => {
    const off = await gitAttribution(
      { config: configWith({ global: false }), majhiHome: join(dir, "home") },
      task,
      "acme-dev",
    );
    expect(off.hooks).toBe(join(dir, "home", "git-hooks"));
    expect(off.git.task).toBe("ACM-7");
    expect(off.git.trailer).toBeUndefined();
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
  /**
   * A repo with task branches of ACM-1 and ACM-2, ACM-1's worktree, and git as a run of `task` would
   * run it there.
   */
  async function twoTasks(): Promise<{
    repo: string;
    wt: string;
    as: (task?: string) => Record<string, string>;
  }> {
    const repo = join(dir, "api");
    await makeRepo(repo, { commit: true });
    await git(repo, "branch", "task/acm-2-other-work");
    await git(repo, "branch", "task/acm-12-similar-id");
    const wt = join(dir, "ACM-1", "api");
    await git(repo, "worktree", "add", "--quiet", "-b", "task/acm-1-own-work", wt);
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
      ...(task === undefined ? {} : { MAJHI_TASK: task, MAJHI_GIT_DIRS: join(repo, ".git") }),
    });
    return { repo, wt, as };
  }

  /** `commit-tree` and `update-ref`, as the lead in the incident moved another task's branch. */
  async function updateRef(cwd: string, env: Record<string, string>, branch: string): Promise<void> {
    const { stdout } = await run("git", ["commit-tree", "-p", "HEAD", "-m", "change", "HEAD^{tree}"], {
      cwd,
      env,
    });
    await run("git", ["update-ref", `refs/heads/${branch}`, stdout.trim()], { cwd, env });
  }

  it("refuses a raw update-ref from a run of another task, and points to change_task_branch", async () => {
    const { repo, wt, as } = await twoTasks();
    const before = await git(repo, "rev-parse", "task/acm-2-other-work");
    const refused = updateRef(wt, as("ACM-1"), "task/acm-2-other-work");
    await expect(refused).rejects.toThrow(/another task \(ACM-2\).*change_task_branch/s);
    expect(await git(repo, "rev-parse", "task/acm-2-other-work")).toBe(before);
    // A task id that only starts the same is another task too.
    await expect(updateRef(wt, as("ACM-1"), "task/acm-12-similar-id")).rejects.toThrow(/ACM-12/);
    await expect(
      run("git", ["branch", "-D", "task/acm-2-other-work"], { cwd: wt, env: as("ACM-1") }),
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
    const { repo, wt, as } = await twoTasks();
    await updateRef(wt, as("ACM-1"), "task/acm-1-own-work");
    expect(await git(repo, "log", "-1", "--format=%s", "task/acm-1-own-work")).toBe("change");
    await updateRef(wt, as(), "task/acm-2-other-work");
    expect(await git(repo, "log", "-1", "--format=%s", "task/acm-2-other-work")).toBe("change");
    await updateRef(wt, as(), "feature/x");
    await updateRef(repo, as(), "main");
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe("change");
  });

  it("still runs the repo's own reference-transaction hook, with its input", async () => {
    const { repo, wt, as } = await twoTasks();
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(
      join(repo, ".git", "hooks", "reference-transaction"),
      '#!/bin/sh\n[ "$1" = committed ] && cat >> "$(git rev-parse --git-common-dir)/seen"\nexit 0\n',
      { mode: 0o755 },
    );
    await updateRef(wt, as("ACM-1"), "task/acm-1-own-work");
    const seen = await readFile(join(repo, ".git", "seen"), "utf8");
    expect(seen).toContain("refs/heads/task/acm-1-own-work");
  });
});

describe("a run in the shared git folder", () => {
  /** Runs git as the run; resolves to its output. */
  const as = (cwd: string, env: Record<string, string>, ...args: string[]) =>
    run("git", args, { cwd, env }).then((r) => r.stdout.trim());

  it("cannot move, delete or commit on the owner's branches", async () => {
    const { repo, wt } = await taskWorktree();
    const env = await runEnv(repo);
    const main = await git(repo, "rev-parse", "main");
    const develop = await git(repo, "rev-parse", "develop");
    await as(wt, env, "commit", "--quiet", "-am", "work");

    await expect(as(wt, env, "update-ref", "refs/heads/main", "HEAD")).rejects.toThrow(
      /main is not a branch of ACM-7/,
    );
    await expect(as(wt, env, "branch", "-f", "main", "HEAD")).rejects.toThrow(/not a branch of ACM-7/);
    await expect(as(wt, env, "branch", "-D", "main")).rejects.toThrow(/main is not a branch/);
    await expect(as(wt, env, "checkout", "--quiet", "-b", "fix/other")).rejects.toThrow(/not a branch/);
    expect(await git(repo, "rev-parse", "main")).toBe(main);
    expect(await git(repo, "rev-parse", "develop")).toBe(develop);
    expect(await git(repo, "branch", "--list", "fix/other")).toBe("");
  });

  it("cannot delete or rename the branch majhi tracks, which a refused rename would lose", async () => {
    const { repo, wt } = await taskWorktree();
    const env = await runEnv(repo);
    await as(wt, env, "commit", "--quiet", "-am", "work");
    const tip = await git(repo, "rev-parse", "task/acm-7-work");
    for (const args of [
      ["branch", "-m", "task/acm-7-work", "task/acm-7-renamed"],
      ["branch", "-M", "task/acm-7-work", "main"],
      ["update-ref", "-d", "refs/heads/task/acm-7-work"],
    ]) {
      await expect(as(wt, env, ...args)).rejects.toThrow(/majhi tracks task\/acm-7-work/);
    }
    expect(await git(repo, "rev-parse", "task/acm-7-work")).toBe(tip);
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe("refs/heads/task/acm-7-work");
  });

  it("cannot switch its worktree to the owner's branch, or commit there", async () => {
    const { repo, wt } = await taskWorktree();
    const env = await runEnv(repo);
    const main = await git(repo, "rev-parse", "main");
    await as(wt, env, "commit", "--quiet", "-am", "work");
    await expect(as(wt, env, "checkout", "--quiet", "main")).rejects.toThrow(/stays on its task branch/);
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe("refs/heads/task/acm-7-work");

    // Older git does not report the switch: post-checkout switches back and fails the checkout.
    await git(wt, "checkout", "--quiet", "main");
    const hook = join(dir, "home", "git-hooks", "post-checkout");
    await expect(run(hook, [main, main, "1"], { cwd: wt, env })).rejects.toThrow(/stays on its task branch/);
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe("refs/heads/task/acm-7-work");

    // Left on main by the owner's git, a commit there is still refused.
    await git(wt, "checkout", "--quiet", "main");
    await expect(as(wt, env, "commit", "--quiet", "--allow-empty", "-m", "sneak")).rejects.toThrow(
      /main is not a branch of ACM-7/,
    );
    expect(await git(repo, "rev-parse", "main")).toBe(main);
  });

  it("cannot move remote-tracking refs, tags, notes or the shared stash", async () => {
    const { repo, wt } = await taskWorktree();
    await git(repo, "update-ref", "refs/remotes/origin/main", "main");
    const env = await runEnv(repo);
    await as(wt, env, "commit", "--quiet", "-am", "work");
    await expect(as(wt, env, "update-ref", "refs/remotes/origin/main", "HEAD")).rejects.toThrow(
      /refs\/remotes\/origin\/main is majhi's copy/,
    );
    await expect(as(wt, env, "update-ref", "-d", "refs/remotes/origin/main")).rejects.toThrow(/majhi's copy/);
    await expect(as(wt, env, "tag", "v1")).rejects.toThrow(/refs\/tags\/v1 is shared/);
    await expect(as(wt, env, "notes", "add", "-m", "x")).rejects.toThrow(/refs\/notes\/commits is shared/);
    await writeFile(join(wt, "a.txt"), "three\n");
    await expect(as(wt, env, "stash")).rejects.toThrow(/the stash is shared/);
    expect(await git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(
      await git(repo, "rev-parse", "main"),
    );
    expect(await git(repo, "tag", "--list")).toBe("");
  });

  it("changes nothing from the project's own checkout", async () => {
    const { repo } = await taskWorktree();
    const env = await runEnv(repo);
    await expect(as(repo, env, "update-ref", "refs/heads/task/acm-7-work", "main")).rejects.toThrow(
      /not in the project's own checkout/,
    );
    await expect(as(repo, env, "update-ref", "--no-deref", "HEAD", "main")).rejects.toThrow(
      /not in the project's own checkout/,
    );
    expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/develop");
  });

  it("works on its own branches: commits, new task branches, detached looks, rebase", async () => {
    const { repo, wt } = await taskWorktree();
    const env = await runEnv(repo);
    await as(wt, env, "commit", "--quiet", "-am", "work");
    await as(wt, env, "checkout", "--quiet", "-b", "task/acm-7-try");
    await as(wt, env, "commit", "--quiet", "--allow-empty", "-m", "try");
    await as(wt, env, "checkout", "--quiet", "task/acm-7-work");
    await as(wt, env, "branch", "-D", "task/acm-7-try");
    await as(wt, env, "checkout", "--quiet", "--detach", "develop");
    await as(wt, env, "checkout", "--quiet", "task/acm-7-work");
    await as(wt, env, "rebase", "--quiet", "develop");
    await as(wt, env, "reset", "--quiet", "--hard", "HEAD");
    expect(await git(repo, "log", "-1", "--format=%s", "task/acm-7-work")).toBe("work");
  });

  it("may work on a branch the owner named for the task", async () => {
    const { repo } = await taskWorktree();
    const wt = join(dir, "ACM-7", "named");
    await git(repo, "worktree", "add", "--quiet", "-b", "feature/login", wt, "main");
    const env = await runEnv(repo, { branch: "feature/login" });
    await as(wt, env, "commit", "--quiet", "--allow-empty", "-m", "login");
    expect(await git(repo, "log", "-1", "--format=%s", "feature/login")).toBe("login");
    await expect(as(wt, env, "branch", "-f", "main", "HEAD")).rejects.toThrow(/not a branch of ACM-7/);
  });

  it("leaves a repo that is not one of the task's alone, like one a test makes", async () => {
    const { repo } = await taskWorktree();
    const env = await runEnv(repo);
    const scratch = join(dir, "scratch");
    await makeRepo(scratch, { commit: true });
    await as(scratch, env, "commit", "--quiet", "--allow-empty", "-m", "two");
    await as(scratch, env, "checkout", "--quiet", "-b", "feature/x");
    await as(scratch, env, "tag", "v1");
    expect(await git(scratch, "log", "-1", "--format=%s", "main")).toBe("two");
  });

  it("keeps history through a plain gc and reflog expire, even when the repo's config would drop it", async () => {
    const { repo, wt } = await taskWorktree();
    for (const [key, value] of [
      ["gc.reflogExpire", "now"],
      ["gc.reflogExpireUnreachable", "now"],
      ["gc.pruneExpire", "now"],
    ] as const) {
      await git(repo, "config", key, value);
    }
    const env = await runEnv(repo);
    expect(await as(wt, env, "config", "--get", "gc.pruneExpire")).toBe("never");
    await as(wt, env, "commit", "--quiet", "-am", "dropped");
    const dropped = await as(wt, env, "rev-parse", "HEAD");
    await as(wt, env, "reset", "--quiet", "--hard", "HEAD~1");
    await as(wt, env, "reflog", "expire", "--all");
    await as(wt, env, "gc", "--quiet");
    await expect(git(repo, "cat-file", "-e", dropped)).resolves.toBe("");

    // The same commands without the run's settings do drop it: the test is not a no-op.
    const ownerEnv = { ...env };
    for (const key of Object.keys(ownerEnv)) if (/^GIT_CONFIG_|^MAJHI_/.test(key)) delete ownerEnv[key];
    await as(wt, ownerEnv, "reflog", "expire", "--all");
    await as(wt, ownerEnv, "gc", "--quiet");
    await expect(git(repo, "cat-file", "-e", dropped)).rejects.toThrow();
  });
});
