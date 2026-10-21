import { buildEnv } from "./env.ts";
import type { AccountRuntime, RuntimeOptions } from "./index.ts";
import { getTool } from "./tools/index.ts";
import type { AccountIdentity } from "./tools/types.ts";

const DEFAULT_IDENTITY_TIMEOUT_MS = 30_000;

/**
 * Who the account's sign-in file belongs to, read in the account's own folder (never a session's home). Spends
 * no model tokens. Rejects with a one-line message when it cannot be read. Not for API-key accounts: they have no
 * sign-in file.
 */
export async function readIdentity(
  account: AccountRuntime,
  options: RuntimeOptions,
): Promise<AccountIdentity> {
  if (account.apiKey !== undefined) throw new Error("An API-key account has no sign-in file");
  const tool = getTool(account.tool);
  return tool.readIdentity({
    account,
    env: buildEnv(account, options.base),
    adapter: options.adapters?.[account.tool] ?? tool.adapter,
    options,
    timeoutMs: options.timeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS,
  });
}
