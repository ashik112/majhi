import type { ToolId } from "@majhi/shared";
import type { AccountProbe, AccountRuntime, RuntimeOptions } from "./index.ts";

/**
 * Checks an account without spending tokens: the CLI starts (`cli`), it reports
 * being signed in (`auth`), and an ACP session opens (`acp`), whose config
 * options give the models and effort levels.
 */
export function probeAccount(_account: AccountRuntime, _options: RuntimeOptions): Promise<AccountProbe> {
  throw new Error("not implemented");
}

/** The CLI version behind a tool's adapter, for `doctor`. Rejects when it does not start. */
export function cliVersion(_tool: ToolId, _options: RuntimeOptions): Promise<string> {
  throw new Error("not implemented");
}
