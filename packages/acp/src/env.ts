import type { AccountRuntime, BaseEnv } from "./index.ts";
import { getTool } from "./tools/index.ts";

export interface GitIdentity {
  name: string;
  email: string;
}

/** Who a run's commits are made as, and the task they link to. */
export interface GitAttribution {
  author: GitIdentity;
  committer: GitIdentity;
  /** Sets `MAJHI_TASK`, which the prepare-commit-msg hook turns into a `Majhi-Task` trailer. Absent: no trailer. */
  task?: string;
  /** A folder of hooks that takes the place of the repo's (`core.hooksPath`, for this run only). */
  hooks?: string;
}

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
    if (git.hooks !== undefined) {
      // Command-line scope, so it wins over the repo's own `core.hooksPath`.
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "core.hooksPath";
      env.GIT_CONFIG_VALUE_0 = git.hooks;
    }
  }
  return env;
}
