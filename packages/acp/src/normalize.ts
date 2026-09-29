import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { ToolContent } from "@majhi/shared";
import { z } from "zod";
import type { MediaBlock, SessionEvent } from "./session.ts";

/** Debug logging hook. Unknown or malformed updates go here and are otherwise ignored. */
export type DebugLog = (message: string, detail?: unknown) => void;

type SessionUpdate = SessionNotification["update"];
type ToolEvent = Extract<SessionEvent, { type: "tool" }>;

/**
 * Gives each contiguous run of message or thought chunks one id. ACP may send
 * `messageId`; when it does, that id wins. Any other event, or a change
 * between message and thought, ends the run.
 */
export class MessageRuns {
  private kind: "text" | "thought" | undefined;
  private current: string | undefined;
  private n = 0;
  constructor(private readonly prefix: string) {}

  idFor(kind: "text" | "thought", given: string | null | undefined): string {
    if (given) {
      this.kind = kind;
      this.current = given;
      return given;
    }
    if (this.kind !== kind || this.current === undefined) {
      this.n += 1;
      this.kind = kind;
      this.current = `${this.prefix}-${this.n}`;
    }
    return this.current;
  }

  /** Ends the run: the next chunk starts a new message. */
  reset(): void {
    this.kind = undefined;
    this.current = undefined;
  }
}

const TerminalMeta = z.object({
  terminal_output: z.object({ data: z.string() }).optional(),
  terminal_exit: z.object({ exit_code: z.number().int().nullable().optional() }).optional(),
});

function mapContent(
  content: readonly { type: string }[] | null | undefined,
  meta: unknown,
): ToolContent[] | undefined {
  if (!content) return undefined;
  const out: ToolContent[] = [];
  const tm = TerminalMeta.safeParse(meta);
  for (const c of content as readonly Record<string, unknown>[]) {
    if (c.type === "content") {
      const block = c.content as { type?: string; text?: string } | undefined;
      if (block?.type === "text" && typeof block.text === "string")
        out.push({ type: "text", text: block.text });
    } else if (c.type === "diff" && typeof c.path === "string" && typeof c.newText === "string") {
      out.push(
        typeof c.oldText === "string"
          ? { type: "diff", path: c.path, oldText: c.oldText, newText: c.newText }
          : { type: "diff", path: c.path, newText: c.newText },
      );
    } else if (c.type === "terminal" && tm.success && tm.data.terminal_output) {
      const code = tm.data.terminal_exit?.exit_code;
      out.push(
        typeof code === "number"
          ? { type: "terminal", output: tm.data.terminal_output.data, exitCode: code }
          : { type: "terminal", output: tm.data.terminal_output.data },
      );
    }
  }
  return out;
}

function toolEvent(u: {
  toolCallId: string;
  title?: string | null | undefined;
  kind?: string | null | undefined;
  status?: string | null | undefined;
  locations?: readonly { path: string }[] | null | undefined;
  content?: readonly { type: string }[] | null | undefined;
  _meta?: unknown;
}): ToolEvent {
  const e: ToolEvent = { type: "tool", toolCallId: u.toolCallId };
  if (u.title) e.title = u.title;
  if (u.kind) e.kind = u.kind;
  if (u.status) e.status = u.status as NonNullable<ToolEvent["status"]>;
  if (u.locations) e.locations = u.locations.map((l) => l.path);
  const content = mapContent(u.content, u._meta);
  if (content) e.content = content;
  return e;
}

/** An image or a link from an ACP content block. Other kinds (audio, embedded resources) are not kept. */
function mediaOf(block: unknown): MediaBlock | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const b = block as Record<string, unknown>;
  if (b.type === "image" && typeof b.data === "string" && b.data !== "" && typeof b.mimeType === "string") {
    return { kind: "image", mime: b.mimeType, data: b.data };
  }
  const uri = typeof b.uri === "string" && b.uri !== "" ? b.uri : undefined;
  if (b.type === "resource_link" && uri !== undefined) {
    const name = typeof b.name === "string" && b.name !== "" ? b.name : uri;
    return typeof b.mimeType === "string"
      ? { kind: "link", uri, name, mime: b.mimeType }
      : { kind: "link", uri, name };
  }
  if (b.type === "image" && uri !== undefined) return { kind: "link", uri, name: uri };
  return undefined;
}

/** Media inside tool call content. They are shown as their own message beside the tool row. */
function toolMedia(
  toolCallId: string,
  content: readonly { type: string }[] | null | undefined,
): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const c of (content ?? []) as readonly Record<string, unknown>[]) {
    if (c.type !== "content") continue;
    const block = mediaOf(c.content);
    if (block) out.push({ type: "media", messageId: `tool-${toolCallId}`, block });
  }
  return out;
}

function textOf(block: { type: string; text?: string }): string | undefined {
  return block.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

/**
 * Maps one ACP `session/update` to zero or more session events. Never throws:
 * anything it does not understand is logged at debug and dropped.
 */
export function normalizeUpdate(update: SessionUpdate, runs: MessageRuns, log: DebugLog): SessionEvent[] {
  try {
    return normalizeInner(update, runs, log);
  } catch (err) {
    log("update could not be normalized", { update, err });
    return [];
  }
}

function normalizeInner(update: SessionUpdate, runs: MessageRuns, log: DebugLog): SessionEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const text = textOf(update.content);
      const type = update.sessionUpdate === "agent_message_chunk" ? "text" : "thought";
      if (text === undefined) {
        const block = type === "text" ? mediaOf(update.content) : undefined;
        if (block === undefined) {
          log("non-text chunk ignored", update.content.type);
          return [];
        }
        return [{ type: "media", messageId: runs.idFor("text", update.messageId), block }];
      }
      return [{ type, messageId: runs.idFor(type, update.messageId), text }];
    }
    case "tool_call":
    case "tool_call_update":
      runs.reset();
      if (typeof update.toolCallId !== "string" || !update.toolCallId) {
        log("tool call without an id ignored");
        return [];
      }
      return [toolEvent(update), ...toolMedia(update.toolCallId, update.content)];
    case "plan":
      runs.reset();
      return [
        { type: "plan", entries: update.entries.map((x) => ({ content: x.content, status: x.status })) },
      ];
    case "plan_update": {
      runs.reset();
      if (update.plan.type !== "items") {
        log("non-item plan ignored", update.plan.type);
        return [];
      }
      return [
        { type: "plan", entries: update.plan.entries.map((x) => ({ content: x.content, status: x.status })) },
      ];
    }
    case "plan_removed":
      runs.reset();
      return [{ type: "plan", entries: [] }];
    case "usage_update": {
      runs.reset();
      const event: Extract<SessionEvent, { type: "usage" }> = {
        type: "usage",
        used: update.used,
        size: update.size,
      };
      if (update.cost) event.cost = { amount: update.cost.amount, currency: update.cost.currency };
      // claude-agent-acp names the model the usage belongs to here; ACP has no field for it.
      const model = update._meta?.["_claude/model"];
      if (typeof model === "string" && model !== "") event.model = model;
      return [event];
    }
    case "available_commands_update":
      runs.reset();
      return [
        {
          type: "commands",
          commands: update.availableCommands.map((c) =>
            c.description ? { name: c.name, description: c.description } : { name: c.name },
          ),
        },
      ];
    case "notice": {
      runs.reset();
      const level = update.severity === "error" ? "error" : update.severity === "info" ? "info" : "warn";
      return [
        {
          type: "notice",
          level,
          text: update.description ? `${update.title}: ${update.description}` : update.title,
        },
      ];
    }
    default:
      // user_message_chunk, current_mode_update, config_option_update (handled by the session),
      // session_info_update, compaction_*, and anything newer than this SDK.
      log("update ignored", (update as { sessionUpdate?: string }).sessionUpdate);
      return [];
  }
}
