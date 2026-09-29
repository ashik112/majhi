import type { AccountProbe, AccountRuntime, RuntimeOptions } from "./index.ts";

/**
 * Checks an account without spending tokens: the CLI starts (`cli`), it reports
 * being signed in (`auth`), and an ACP session opens (`acp`), whose config
 * options give the models and effort levels.
 */
export function probeAccount(_account: AccountRuntime, _options: RuntimeOptions): Promise<AccountProbe> {
  throw new Error("not implemented");
}
