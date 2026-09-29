import type { ToolSpec } from "../index.ts";

/** What a tool's auth status command reported. */
export interface AuthStatus {
  signedIn: boolean;
  /** Email or account name, when the CLI reports one. */
  as?: string;
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
  /** Extra env for API-key accounts, on top of the key itself. */
  apiKeyEnv?: Record<string, string>;
}
