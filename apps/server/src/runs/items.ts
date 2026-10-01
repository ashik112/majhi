import type { SessionEvent } from "@majhi/acp";
import type { MediaRef, RoomItem, ToolContent } from "@majhi/shared";
import type { RoomPayload } from "../store/index.ts";
import type { MediaSink } from "./media.ts";

/** Terminal output past this is cut in the middle. */
export const TERMINAL_MAX_CHARS = 16 * 1024;

export interface ItemSink {
  post(id: string, payload: RoomPayload, options?: { defer?: boolean }): void;
}

type ToolPayload = Extract<RoomPayload, { type: "tool" }>;
type PlanEntries = Extract<RoomPayload, { type: "plan" }>["entries"];

/**
 * Turns one agent's session events into room items: text merged per message, tool calls
 * created and patched in place, one plan per agent. Item ids include the run, so a restarted
 * session never overwrites an earlier one.
 */
export class ItemMapper {
  private turn = 0;
  private readonly text = new Map<string, string>();
  private readonly media = new Map<string, MediaRef[]>();
  private readonly tools = new Map<string, ToolPayload>();
  private plan: PlanEntries = [];
  /** Key of the agent message this turn wrote last: its final message (5.3). */
  private lastMessage: string | undefined;

  constructor(
    private readonly agent: string,
    private readonly run: number,
    private readonly sink: ItemSink,
    private readonly files?: MediaSink,
  ) {}

  beginTurn(): void {
    this.turn++;
    this.lastMessage = undefined;
  }

  /** The text of the turn's last agent message, or empty when it wrote none. */
  finalText(): string {
    return this.lastMessage === undefined ? "" : (this.text.get(this.lastMessage) ?? "");
  }

  apply(event: SessionEvent): void {
    switch (event.type) {
      case "text":
        this.stream("agent", "t", event.messageId, event.text);
        return;
      case "thought":
        this.stream("thought", "h", event.messageId, event.text);
        return;
      case "media":
        this.addMedia(event);
        return;
      case "tool":
        this.tool(event);
        return;
      case "plan":
        this.plan = event.entries;
        this.sink.post(`plan:${this.agent}`, { type: "plan", agent: this.agent, entries: event.entries });
        return;
      default:
        return;
    }
  }

  /** One line for the agent's avatar: the latest tool in progress, else the plan step in progress. */
  nowDoing(): string | undefined {
    let latest: string | undefined;
    for (const tool of this.tools.values()) {
      if (tool.status === "in_progress" || tool.status === "pending") latest = tool.title;
    }
    return latest ?? this.plan.find((e) => e.status === "in_progress")?.content;
  }

  /** After a cancelled or failed turn, tool calls still running are marked failed. */
  endTurn(unfinished: boolean): void {
    if (!unfinished) return;
    for (const [id, tool] of this.tools) {
      if (tool.status !== "pending" && tool.status !== "in_progress") continue;
      const next: ToolPayload = { ...tool, status: "failed" };
      this.tools.set(id, next);
      this.sink.post(this.toolItemId(id), next);
    }
  }

  private stream(type: "agent" | "thought", tag: string, messageId: string, chunk: string): void {
    const key = `${this.turn}:${tag}:${messageId}`;
    const text = (this.text.get(key) ?? "") + chunk;
    this.text.set(key, text);
    if (type === "agent") this.lastMessage = key;
    const media = type === "agent" ? this.media.get(key) : undefined;
    this.sink.post(
      `${this.agent}:${this.run}:${key}`,
      media === undefined
        ? { type, agent: this.agent, text }
        : { type: "agent", agent: this.agent, text, media },
      { defer: true },
    );
  }

  /** An image or link joins its message, next to the text. Without a place to save files it is dropped. */
  private addMedia(event: Extract<SessionEvent, { type: "media" }>): void {
    const ref =
      event.block.kind === "image"
        ? this.files?.image(event.block.mime, event.block.data)
        : this.files?.link(event.block);
    if (ref === undefined) return;
    const key = `${this.turn}:t:${event.messageId}`;
    const media = [...(this.media.get(key) ?? []), ref];
    this.media.set(key, media);
    this.sink.post(
      `${this.agent}:${this.run}:${key}`,
      { type: "agent", agent: this.agent, text: this.text.get(key) ?? "", media },
      { defer: true },
    );
  }

  private tool(event: Extract<SessionEvent, { type: "tool" }>): void {
    const before = this.tools.get(event.toolCallId);
    const next: ToolPayload = {
      type: "tool",
      agent: this.agent,
      toolCallId: event.toolCallId,
      title: event.title ?? before?.title ?? "Working",
      kind: event.kind ?? before?.kind ?? "other",
      status: event.status ?? before?.status ?? "pending",
      locations: event.locations ?? before?.locations ?? [],
      content: event.content === undefined ? (before?.content ?? []) : event.content.map(trimContent),
    };
    this.tools.set(event.toolCallId, next);
    this.sink.post(this.toolItemId(event.toolCallId), next);
  }

  /** The title a tool call was shown with, like Codex's `mcp.<server>.<tool>`. */
  toolTitle(toolCallId: string): string | undefined {
    return this.tools.get(toolCallId)?.title;
  }

  private toolItemId(toolCallId: string): string {
    return `tool:${this.agent}:${this.run}:${toolCallId}`;
  }
}

/** Keeps the start and the end of long terminal output. */
export function trimContent(content: ToolContent): ToolContent {
  if (content.type !== "terminal" || content.output.length <= TERMINAL_MAX_CHARS) return content;
  const half = TERMINAL_MAX_CHARS / 2;
  const cut = content.output.length - TERMINAL_MAX_CHARS;
  return {
    ...content,
    output: `${content.output.slice(0, half)}\n[${cut} characters cut]\n${content.output.slice(-half)}`,
  };
}

type OwnerPayload = Extract<RoomPayload, { type: "owner" }>;
type HandoffPayload = Extract<RoomPayload, { type: "handoff" }>;

/** A handoff item's own fields, to write it back. */
export function handoffPayload(item: Extract<RoomItem, { type: "handoff" }>): HandoffPayload {
  return {
    type: "handoff",
    from: item.from,
    to: item.to,
    via: item.via,
    text: item.text,
    queued: item.queued,
  };
}
type PermissionPayload = Extract<RoomPayload, { type: "permission" }>;

/** An owner item's own fields with some replaced, to write it back. */
export function ownerPayload(
  item: Extract<RoomItem, { type: "owner" }>,
  patch: Partial<Pick<OwnerPayload, "queued" | "removed">>,
): OwnerPayload {
  return {
    type: "owner",
    text: item.text,
    attachments: item.attachments,
    queued: patch.queued ?? item.queued,
    ...((patch.removed ?? item.removed) === true ? { removed: true } : {}),
    ...(item.to === undefined ? {} : { to: item.to }),
  };
}

/** A permission item's own fields with some replaced, to write it back. */
export function permissionPayload(
  item: Extract<RoomItem, { type: "permission" }>,
  patch: Partial<Pick<PermissionPayload, "state" | "chosen">>,
): PermissionPayload {
  const chosen = patch.chosen ?? item.chosen;
  return {
    type: "permission",
    agent: item.agent,
    title: item.title,
    options: item.options,
    state: patch.state ?? item.state,
    ...(item.toolCallId === undefined ? {} : { toolCallId: item.toolCallId }),
    ...(chosen === undefined ? {} : { chosen }),
    ...(item.connection === undefined ? {} : { connection: item.connection }),
  };
}
