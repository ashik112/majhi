import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildEnv } from "@majhi/acp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "../config/service.ts";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { ensureHooks, gitAttribution } from "./attribution.ts";

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
