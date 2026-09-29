import type { AccountRuntime, BaseEnv } from "./index.ts";
import { getTool } from "./tools/index.ts";

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Builds a spawned agent's environment from scratch (SPEC 5.1): the base
 * values, HOME and the tool's config home set to the account home, the API
 * key variable for API-key accounts, and the org's git identity. No SSH agent
 * socket: agents cannot push or fetch over SSH.
 * Never reads `process.env`.
 */
export function buildEnv(account: AccountRuntime, base: BaseEnv, git?: GitIdentity): Record<string, string> {
  const tool = getTool(account.tool);
  const env: Record<string, string> = { PATH: base.PATH };
  if (base.TMPDIR) env.TMPDIR = base.TMPDIR;
  if (base.LANG) env.LANG = base.LANG;
  if (base.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = base.PLAYWRIGHT_BROWSERS_PATH;

  env.HOME = account.home;
  env[tool.configHomeVar] = account.home;

  if (account.apiKey) {
    env[tool.apiKeyVar] = account.apiKey;
    Object.assign(env, tool.apiKeyEnv);
  }

  if (git) {
    env.GIT_AUTHOR_NAME = git.name;
    env.GIT_AUTHOR_EMAIL = git.email;
    env.GIT_COMMITTER_NAME = git.name;
    env.GIT_COMMITTER_EMAIL = git.email;
  }
  return env;
}
