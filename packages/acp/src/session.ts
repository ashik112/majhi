import type { ToolContent } from "@majhi/shared";
import type { SessionOptions } from "./acp-session.ts";
import type { GitAttribution } from "./env.ts";
import type { AccountRuntime, RuntimeOptions } from "./index.ts";
import type { DebugLog } from "./normalize.ts";
import { openSession } from "./session-impl.ts";
import type { RunMount } from "./spawn.ts";
import type { ContextCap } from "./tools/types.ts";
import type { TurnUsage } from "./turn-usage.ts";

/**
 * One live ACP session with an agent process (SPEC 5.1, 5.15). The server's
 * run manager owns one per (task, agent). Everything the agent reports is
 * normalized into `SessionEvent`s; nothing ACP-specific leaks past this file.
 */
export interface SessionStart {
  account: AccountRuntime;
  options: RuntimeOptions;
  /** The task folder. */
  cwd: string;
  git?: GitAttribution;
  /** MCP servers to attach (Phase 2b adds majhi-admin for the captain). */
  mcpServers?: (McpServerSpec | StdioServerSpec)[];
  /** Variables of the run's connections (SPEC 5.14). The run's own variables win over them. */
  env?: Record<string, string>;
  /** Compact inside a turn at this cap, where the tool's CLI can (`info.midTurnCapMin`). */
  contextCap?: ContextCap;
  /** Resume this ACP session id with session/load when the agent supports it. */
  resume?: string;
  model?: string;
  effort?: string;
  /** More paths the run may use besides the task folder and the account home, like each task repo's `.git`. */
  mounts?: RunMount[];
  /** `cwd` is a throwaway folder (the decision stand-in): a runner container uses its own. */
  scratch?: boolean;
  /** The task the session belongs to: its runner joins the task's service network. */
  task?: string;
  /** How long `cancel()` waits for the turn to end. Default 10 s. */
  cancelTimeoutMs?: number;
}

/** A remote server: Streamable HTTP, or server-sent events for the older ones. */
export type McpServerSpec = {
  type: "http" | "sse";
  name: string;
  url: string;
  headers: Record<string, string>;
};

/** A server the agent CLI starts itself as a subprocess, in its own runner container. */
export type StdioServerSpec = {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type SessionEvent =
  | { type: "text"; messageId: string; text: string } // appended chunk
  | { type: "thought"; messageId: string; text: string }
  /** An image (base64) or a link the agent sent as a content block of a message or tool call. */
  | { type: "media"; messageId: string; block: MediaBlock }
  | {
      type: "tool";
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: "pending" | "in_progress" | "completed" | "failed";
      locations?: string[];
      content?: ToolContent[];
      /** Claude Code's `Skill` tool call: the skill it loaded. */
      skill?: string;
    } // create or patch
  | { type: "plan"; entries: { content: string; status: "pending" | "in_progress" | "completed" }[] }
  /** Context use, and the adapter's running session cost when it reports one. */
  | {
      type: "usage";
      used: number;
      size: number;
      cost?: { amount: number; currency: string };
      model?: string;
    }
  /**
   * The CLI compacted its context (PRV-103), as the adapter reports it: a "Compact conversation"
   * tool call, sent once per state. `status` is absent on a patch that only adds facts. Claude
   * gives the trigger and the tokens before and after; Codex gives neither.
   */
  | {
      type: "compaction";
      id: string;
      status?: "started" | "completed" | "failed";
      trigger?: "auto" | "manual";
      before?: number;
      after?: number;
    }
  /** A prompt finished: its tokens and cost (Phase 2c). Sent just before `prompt()` resolves. */
  | { type: "turn"; usage: TurnUsage }
  | { type: "commands"; commands: { name: string; description?: string }[] }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  /** Current model and effort ids changed (the agent reported new config options, or `setOption` ran). */
  | { type: "config"; model?: string; effort?: string }
  | { type: "exit"; code: number | null; error?: string }; // process died

export type MediaBlock =
  | { kind: "image"; mime: string; data: string }
  | { kind: "link"; uri: string; name: string; mime?: string };

export interface PermissionAsk {
  toolCallId?: string;
  title: string;
  kind?: string; // ACP tool kind, for auto-allow by perms
  command?: string; // for execute: the command line, when known
  options: {
    id: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }[];
}

export interface AgentSession {
  readonly sessionId: string;
  /** Process id of the adapter (its process group id too). For diagnostics and tests. */
  readonly pid: number | undefined;
  readonly models: SessionOptions; // current model/effort options
  onEvent(listener: (e: SessionEvent) => void): () => void;
  /** Called for every permission request; resolve with an option id, or undefined to cancel. */
  setPermissionHandler(
    handler: (ask: PermissionAsk, signal: AbortSignal) => Promise<string | undefined>,
  ): void;
  /** Sends one prompt and resolves when the turn ends. */
  prompt(
    blocks: PromptBlock[],
  ): Promise<{ stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" }>;
  cancel(): Promise<void>;
  setOption(category: "model" | "thought_level", value: string): Promise<void>;
  close(): Promise<void>; // kills the process group
}

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string } // base64
  | { type: "resource_link"; uri: string; name: string; mime?: string };

export function startSession(start: SessionStart, log?: DebugLog): Promise<AgentSession> {
  return openSession(start, log);
}
