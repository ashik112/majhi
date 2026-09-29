import type { AccountProbe, AccountRuntime, LoginSpec, RuntimeOptions } from "@majhi/acp";
import * as acp from "@majhi/acp";
import type { AccountUsage, ToolId, ToolInfo } from "@majhi/shared";

/**
 * The part of `@majhi/acp` the server calls. Services take this so tests can
 * pass a fake and never start a real CLI.
 */
export interface AcpRuntime {
  toolInfos(): ToolInfo[];
  prepareHome(account: AccountRuntime): Promise<void>;
  loginCommand(account: AccountRuntime, options: RuntimeOptions): LoginSpec;
  probeAccount(account: AccountRuntime, options: RuntimeOptions): Promise<AccountProbe>;
  /** Undefined for API-key accounts. Rejects when the read fails. */
  readUsage(account: AccountRuntime, options: RuntimeOptions): Promise<AccountUsage | undefined>;
  cliVersion(tool: ToolId, options: RuntimeOptions): Promise<string>;
}

export const realRuntime: AcpRuntime = {
  toolInfos: acp.toolInfos,
  prepareHome: acp.prepareHome,
  loginCommand: acp.loginCommand,
  probeAccount: acp.probeAccount,
  readUsage: acp.readUsage,
  cliVersion: acp.cliVersion,
};
