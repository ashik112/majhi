import { join } from "node:path";
import type { AccountRuntime } from "@majhi/acp";
import type { AccountConfig } from "@majhi/shared";

/** `<majhi home>/accounts/<id>`: the account's own CLI config home. Ids cannot contain slashes or dots. */
export function accountHome(majhiHome: string, id: string): string {
  return join(majhiHome, "accounts", id);
}

export function accountRuntime(
  majhiHome: string,
  id: string,
  config: AccountConfig,
  apiKey?: string,
): AccountRuntime {
  const account: AccountRuntime = { tool: config.tool, home: accountHome(majhiHome, id) };
  if (apiKey !== undefined) account.apiKey = apiKey;
  return account;
}

/** The secret name behind `key: secret:<name>`. */
export function secretName(ref: string): string {
  return ref.replace(/^secret:/, "");
}
