import type { AccountUsage } from "@majhi/shared";
import type { AccountRuntime, Command, RuntimeOptions, ToolSpec } from "../index.ts";
import type { UsageMode } from "../turn-usage.ts";

/** The context cap of one session: tokens, and the share of it at which majhi compacts. */
export interface ContextCap {
  tokens: number;
  compactAt: number;
}

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
 * How a tool says that an account hit its usage, rate or credit limit (5.7). `error` is checked on
 * an error's text. `line` is stricter, anchored at the start: it is checked on the first line of a
 * turn's text, where the CLI prints its limit message and where an agent's own prose could also
 * say "rate limit".
 */
export interface LimitShapes {
  error: readonly RegExp[];
  line: readonly RegExp[];
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
  /** The words this CLI uses when the account hit a limit. See `limitFailure`. */
  limitShapes: LimitShapes;
  /** Extra env for API-key accounts, on top of the key itself. */
  apiKeyEnv?: Record<string, string>;
  /**
   * Set on every run of this tool. Used to keep account-synced extras (claude.ai connectors,
   * plugins' MCP servers) out of agent sessions: an agent gets only the tools majhi attaches.
   */
  runEnv?: Record<string, string>;
  /**
   * The CLI is started with the session's MCP servers on its command line, and expands `${NAME}`
   * in them from its environment. majhi then puts header and variable values in the environment
   * instead (`mcpValuesToEnv`), so no token shows in a process list. Absent when the CLI keeps
   * them in its own memory (Codex).
   */
  mcpOnArgv?: boolean;
  /** How the adapter's per-prompt `usage` counts (see turn-usage.ts). */
  turnUsage: UsageMode;
  /**
   * Makes the CLI compact inside a turn at a context cap, as env for the adapter. Absent when the
   * CLI has no such setting. `info.midTurnCapMin` is the smallest cap it honours.
   */
  capEnv?(cap: ContextCap): Record<string, string>;
}
