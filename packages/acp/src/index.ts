/**
 * majhi's side of the Agent Client Protocol: the tool registry, the per-run
 * environment, login commands, and checks that open an ACP session without
 * spending tokens (SPEC 5.1, 5.2, 5.8).
 *
 * This file is the public surface other packages code against. Keep it
 * stable; implementation lives in the modules it re-exports.
 */
import type { AccountModels, HealthCheck, ToolId, ToolInfo } from "@majhi/shared";

/** A command to spawn: never a shell string. */
export interface Command {
  command: string;
  args: string[];
}

/**
 * The only host values a spawned agent may see. There is no SSH agent socket
 * here: agents have no SSH access, and only majhi's own git uses the socket.
 * The server fills this from its own environment once; nothing else from
 * `process.env` ever reaches an agent.
 */
export interface BaseEnv {
  PATH: string;
  TMPDIR?: string;
  LANG?: string;
  /** Where the image keeps Playwright's browsers, so agents can run browser tests. */
  PLAYWRIGHT_BROWSERS_PATH?: string;
}

export interface RuntimeOptions {
  base: BaseEnv;
  /**
   * Replaces the ACP adapter command per tool. Tests point this at the fake
   * agent in `@majhi/acp/testing`; production leaves it empty and uses the
   * adapters installed in the image (`claude-agent-acp`, `codex-acp`).
   */
  adapters?: Partial<Record<ToolId, Command>>;
  /**
   * Replaces the command that reads Claude usage. Tests point this at the fake
   * agent. Codex usage goes through the adapter, so `adapters` covers it.
   */
  usage?: Partial<Record<ToolId, Command>>;
  /** Per-step timeout for probes. Default 20 s. */
  timeoutMs?: number;
}

/** One account as the runtime needs it. */
export interface AccountRuntime {
  tool: ToolId;
  /** Absolute path of the account's config home. Created by the caller. */
  home: string;
  /** Plain API key for `api-key` accounts, decrypted by the server just before use. Never logged. */
  apiKey?: string;
}

export interface ToolSpec {
  info: ToolInfo;
  /** `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. */
  configHomeVar: string;
  /** `ANTHROPIC_API_KEY` or `CODEX_API_KEY`. */
  apiKeyVar: string;
  /** Default adapter command, for example `claude-agent-acp`. */
  adapter: Command;
}

export interface LoginSpec extends Command {
  env: Record<string, string>;
  /** The command as shown to the owner, with env var names but no secrets. */
  display: string;
}

export interface AccountProbe {
  health: HealthCheck;
  /** Signed-in email or account name, when the CLI reports one. */
  signedInAs?: string;
  /** Present when the ACP step succeeded. The caller adds `account`. */
  models?: Omit<AccountModels, "account">;
}

export { buildEnv, type GitIdentity } from "./env.ts";
export { prepareHome } from "./home.ts";
export { loginCommand } from "./login.ts";
export { cliVersion, probeAccount } from "./probe.ts";
export {
  type AgentSession,
  type McpServerSpec,
  type MediaBlock,
  type PermissionAsk,
  type PromptBlock,
  type SessionEvent,
  type SessionStart,
  startSession,
} from "./session.ts";
export { mapClaudeUsage } from "./tools/claude.ts";
export { mapCodexRateLimits } from "./tools/codex.ts";
export { getTool, toolInfos, tools } from "./tools/index.ts";
export { readUsage } from "./usage.ts";
