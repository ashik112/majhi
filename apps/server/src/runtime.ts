import type {
  AccountIdentity,
  AccountProbe,
  AccountRuntime,
  AgentSession,
  LoginSpec,
  RuntimeOptions,
  SessionStart,
} from "@majhi/acp";
import * as acp from "@majhi/acp";
import type { AccountUsage, ToolId, ToolInfo } from "@majhi/shared";

/**
 * The part of `@majhi/acp` the server calls. Services take this so tests can
 * pass a fake and never start a real CLI.
 */
export interface AcpRuntime {
  /** Opens an ACP session with an agent CLI. */
  startSession(start: SessionStart): Promise<AgentSession>;
  toolInfos(): ToolInfo[];
  /** `options` tells how the session will run: a home made for a runner gets a place to mount the sign-in file, one next to majhi a link. */
  prepareHome(account: AccountRuntime, options?: RuntimeOptions): Promise<void>;
  loginCommand(account: AccountRuntime, options: RuntimeOptions): LoginSpec;
  probeAccount(account: AccountRuntime, options: RuntimeOptions): Promise<AccountProbe>;
  /** Undefined for API-key accounts. Rejects when the read fails. */
  readUsage(account: AccountRuntime, options: RuntimeOptions): Promise<AccountUsage | undefined>;
  cliVersion(tool: ToolId, options: RuntimeOptions): Promise<string>;
  /** Who the account's sign-in file belongs to, read in the account's own folder. Rejects when it cannot be read. */
  readIdentity(account: AccountRuntime, options: RuntimeOptions): Promise<AccountIdentity>;
  /** When the account's sign-in file runs out (ms since the epoch), or undefined when the file does not say. */
  signInExpiresAt(account: AccountRuntime): Promise<number | undefined>;
}

export const realRuntime: AcpRuntime = {
  toolInfos: acp.toolInfos,
  prepareHome: acp.prepareHome,
  loginCommand: acp.loginCommand,
  probeAccount: acp.probeAccount,
  readUsage: acp.readUsage,
  cliVersion: acp.cliVersion,
  readIdentity: acp.readIdentity,
  signInExpiresAt: acp.signInExpiresAt,
  startSession: (start) => acp.startSession(start),
};
