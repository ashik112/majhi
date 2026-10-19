import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildEnv } from "@majhi/acp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "../config/service.ts";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { seedHooks } from "../testing/hooks.ts";
import { gitAttribution } from "./attribution.ts";

const run = promisify(execFile);

let dir: string;
/** A global git config that stops every commit from starting a background `git maintenance`. */
let quietConfig: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  quietConfig = join(dir, "gitconfig");
  await writeFile(quietConfig, "[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n");
  vi.stubEnv("GIT_CONFIG_GLOBAL", quietConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  await seedHooks(join(dir, "home"));
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
  options: { attribution?: boolean; branch?: string; worktree?: string } = {},
): Promise<Record<string, string>> {
  const attribution = await gitAttribution(
    { config: configWith({ global: options.attribution ?? true }), majhiHome: join(dir, "home") },
    {
      id: "ACM-7",
      org: "acme",
      repos: [
        {
          project: "api",
          branch: options.branch ?? "task/acm-7-work",
          source: repo,
          ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
        },
      ],
    },
    "acme-dev",
  );
  return {
    ...buildEnv({ tool: "claude", home: dir }, { PATH: process.env.PATH ?? "" }, attribution.git),
    GIT_CONFIG_GLOBAL: quietConfig,
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

describe("a run in the shared git folder", () => {
  /** Runs git as the run; resolves to its output. */
  const as = (cwd: string, env: Record<string, string>, ...args: string[]) =>
    run("git", args, { cwd, env }).then((r) => r.stdout.trim());

  // Only this test commits through the run's hooks, to show a run can commit on its own branch. Every
  // hook is a shell with several git processes, so the other tests make their commit as the owner.
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
});
