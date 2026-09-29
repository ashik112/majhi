import { buildEnv } from "./env.ts";
import type { AccountRuntime, LoginSpec, RuntimeOptions } from "./index.ts";
import { getTool } from "./tools/index.ts";

/** The tool's own login command for a login account, run in the embedded terminal against the account home. */
export function loginCommand(account: AccountRuntime, options: RuntimeOptions): LoginSpec {
  if (account.apiKey !== undefined) throw new Error("API-key accounts have no login command");
  const tool = getTool(account.tool);
  const adapter = options.adapters?.[account.tool] ?? tool.adapter;
  const args = [...adapter.args, ...tool.loginArgs];
  // The display names the config home var only: no other env, no secrets.
  const display = [`${tool.configHomeVar}=${account.home}`, adapter.command, ...tool.loginArgs].join(" ");
  return {
    command: adapter.command,
    args,
    env: buildEnv({ tool: account.tool, home: account.home }, options.base),
    display,
  };
}
