import type { ToolContent } from "@majhi/shared";
import type { SessionOptions } from "./acp-session.ts";
import type { GitIdentity } from "./env.ts";
import type { AccountRuntime, RuntimeOptions } from "./index.ts";
import type { DebugLog } from "./normalize.ts";
import { openSession } from "./session-impl.ts";

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
  git?: GitIdentity;
  /** MCP servers to attach (Phase 2b adds majhi-admin for the boss). */
  mcpServers?: McpServerSpec[];
  /** Resume this ACP session id with session/load when the agent supports it. */
  resume?: string;
  model?: string;
  effort?: string;
  /** How long `cancel()` waits for the turn to end. Default 10 s. */
  cancelTimeoutMs?: number;
}

export type McpServerSpec = { type: "http"; name: string; url: string; headers: Record<string, string> };

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
    } // create or patch
  | { type: "plan"; entries: { content: string; status: "pending" | "in_progress" | "completed" }[] }
  | { type: "usage"; used: number; size: number }
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
