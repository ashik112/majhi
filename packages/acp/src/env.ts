import type { AccountRuntime, BaseEnv } from "./index.ts";
import { getTool } from "./tools/index.ts";

export interface GitIdentity {
  name: string;
  email: string;
}

/** Who a run's commits are made as, the task they belong to, and the git guard rails of the run. */
export interface GitAttribution {
  author: GitIdentity;
  committer: GitIdentity;
  /**
   * Sets `MAJHI_TASK`: majhi's hooks then keep the run's git on the task's own branches. Absent: the
   * hooks refuse nothing (the owner's git, majhi's own).
   */
  task?: string;
  /** The task's working branches besides `task/<id>-*` (a branch the owner named): `MAJHI_BRANCHES`. */
  branches?: readonly string[];
  /**
   * The git folders of the task's repos, one per line in `MAJHI_GIT_DIRS`: the hooks guard only these,
   * the only ones a run can write. A repo the agent makes itself (a test's) stays its own.
   */
  gitDirs?: readonly string[];
  /** Sets `MAJHI_TRAILER`, which the prepare-commit-msg hook turns into a `Majhi-Task` trailer. */
  trailer?: boolean;
  /** A folder of hooks that takes the place of the repo's (`core.hooksPath`, for this run only). */
  hooks?: string;
}

/**
 * Git settings of every run that has majhi's hooks, in the command-line scope, so they win over the
 * repo's own. An agent's plain `git gc` or `git reflog expire` then drops nothing: no automatic gc,
 * no pruning of loose objects, refs never packed, reflogs kept forever and written for every ref.
 * `gc.worktreePruneExpire` only stops `git gc` from pruning other checkouts' worktree entries (the run
 * cannot see their folders); an explicit `git worktree prune` ignores it. What stops that is the
 * read-only `.git/worktrees` mount and the lock on every task worktree. Explicit flags
 * (`--prune=now`, `--expire=now`) still win over these.
 */
export const RUN_GIT_CONFIG: readonly (readonly [key: string, value: string])[] = [
  ["gc.auto", "0"],
  ["gc.pruneExpire", "never"],
  ["gc.worktreePruneExpire", "never"],
  ["gc.reflogExpire", "never"],
  ["gc.reflogExpireUnreachable", "never"],
  ["core.logAllRefUpdates", "always"],
  // Packing refs rewrites every branch, which majhi's ref guard cannot tell from changing them
  // (git 2.39 reports a create and a delete per ref). A run's gc leaves refs as they are.
  ["gc.packRefs", "false"],
];

/**
 * Builds a spawned agent's environment from scratch (SPEC 5.1): the base
 * values, HOME and the tool's config home set to the account home, the API
 * key variable for API-key accounts, and the git attribution of its commits. No SSH agent
 * socket: agents cannot push or fetch over SSH.
 * Never reads `process.env`.
 */
export function buildEnv(
  account: AccountRuntime,
  base: BaseEnv,
  git?: GitAttribution,
): Record<string, string> {
  const tool = getTool(account.tool);
  const env: Record<string, string> = { PATH: base.PATH };
  if (base.TMPDIR) env.TMPDIR = base.TMPDIR;
  if (base.LANG) env.LANG = base.LANG;
  if (base.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = base.PLAYWRIGHT_BROWSERS_PATH;

  Object.assign(env, tool.runEnv);
  env.HOME = account.home;
  env[tool.configHomeVar] = account.home;

  if (account.apiKey) {
    env[tool.apiKeyVar] = account.apiKey;
    Object.assign(env, tool.apiKeyEnv);
  }

  if (git) {
    env.GIT_AUTHOR_NAME = git.author.name;
    env.GIT_AUTHOR_EMAIL = git.author.email;
    env.GIT_COMMITTER_NAME = git.committer.name;
    env.GIT_COMMITTER_EMAIL = git.committer.email;
    if (git.task !== undefined) env.MAJHI_TASK = git.task;
    if (git.task !== undefined && git.branches !== undefined && git.branches.length > 0) {
      env.MAJHI_BRANCHES = git.branches.join(" ");
    }
    if (git.task !== undefined && git.gitDirs !== undefined && git.gitDirs.length > 0) {
      env.MAJHI_GIT_DIRS = git.gitDirs.join("\n");
    }
    if (git.task !== undefined && git.trailer === true) env.MAJHI_TRAILER = "1";
    if (git.hooks !== undefined) {
      // Command-line scope, so it wins over the repo's own `core.hooksPath` and gc settings.
      const config: (readonly [string, string])[] = [["core.hooksPath", git.hooks], ...RUN_GIT_CONFIG];
      env.GIT_CONFIG_COUNT = String(config.length);
      config.forEach(([key, value], i) => {
        env[`GIT_CONFIG_KEY_${i}`] = key;
        env[`GIT_CONFIG_VALUE_${i}`] = value;
      });
    }
  }
  return env;
}
