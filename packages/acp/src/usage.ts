import type { AccountUsage } from "@majhi/shared";
import { buildEnv } from "./env.ts";
import type { AccountRuntime, RuntimeOptions } from "./index.ts";
import { getTool } from "./tools/index.ts";

const DEFAULT_USAGE_TIMEOUT_MS = 30_000;

/**
 * Reads the account's 5-hour and weekly usage without spending model tokens.
 * Returns undefined for API-key accounts: they have no windows (SPEC 5.8).
 * Rejects with a one-line message when the read fails.
 */
export async function readUsage(
  account: AccountRuntime,
  options: RuntimeOptions,
): Promise<AccountUsage | undefined> {
  if (account.apiKey !== undefined) return undefined;
  const tool = getTool(account.tool);
  return tool.readUsage({
    account,
    env: buildEnv(account, options.base),
    adapter: options.adapters?.[account.tool] ?? tool.adapter,
    options,
    timeoutMs: options.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS,
  });
}
