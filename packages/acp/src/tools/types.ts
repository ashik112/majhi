import type { AccountUsage } from "@majhi/shared";
import type { AccountRuntime, Command, RuntimeOptions, ToolSpec } from "../index.ts";

/** What a tool's auth status command reported. */
export interface AuthStatus {
  signedIn: boolean;
  /** Email or account name, when the CLI reports one. */
  as?: string;
}

/** What a tool needs to read an account's usage windows. */
export interface UsageContext {
  account: AccountRuntime;
  /** The account's environment from `buildEnv`. */
  env: Record<string, string>;
  /** The ACP adapter command, already replaced by `RuntimeOptions.adapters` when set. */
  adapter: Command;
  options: RuntimeOptions;
  timeoutMs: number;
}

/**
 * A `ToolSpec` plus the tool's own CLI argv. These are appended to the adapter
 * command, so `claude-agent-acp --cli auth status --json` is
 * `adapter` + `authStatusArgs`. Adding a tool means writing one of these.
 */
export interface ToolDef extends ToolSpec {
  versionArgs: string[];
  authStatusArgs: string[];
  /** Login for `login` accounts, run in the embedded terminal. */
  loginArgs: string[];
  /** Reads the auth status command's exit code and stdout. Never throws. */
  parseAuthStatus(exitCode: number, stdout: string): AuthStatus;
  /**
   * Reads the 5-hour and weekly windows without spending model tokens.
   * Rejects with a one-line message when the read fails.
   */
  readUsage(ctx: UsageContext): Promise<AccountUsage>;
  /** Extra env for API-key accounts, on top of the key itself. */
  apiKeyEnv?: Record<string, string>;
}
