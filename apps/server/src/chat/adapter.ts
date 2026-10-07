import type { Body, ChatApp, ChatCursor, ChatEnvelope, ChatFileRef, ChatTrouble } from "@majhi/shared";
import type { People } from "./format.ts";

/**
 * One chat app account as the adapters see it. The token is read from secrets.age when the hub starts the adapter
 * and goes nowhere else: not into a log, an error, a room or an agent's environment.
 */
export interface ChatConnection {
  /** The connection's id. */
  id: string;
  org: string;
  app: ChatApp;
  /** Who the app says the token belongs to, like the bot's @name. */
  account: string;
  token: string;
  /** A folder the adapter may write fetched files into. */
  filesDir: string;
}

export interface ChatTarget {
  chat: string;
  thread?: string | undefined;
  replyTo?: string | undefined;
}

export interface ChatCapabilities {
  threads: boolean;
  edits: boolean;
  deletes: boolean;
  /** How long after a message the app still lets a reply be sent. */
  replyWindowHours?: number;
  /** The most characters one message holds. */
  maxText: number;
  /** How long the app keeps what was sent while majhi was not reading. A longer pause leaves a gap. */
  retentionHours?: number;
}

/** What majhi writes to a chat: the neutral body, and who its mentions name on the app being written to. */
export interface ChatMessage {
  body: Body;
  people: People;
}

/** What the hub gives an adapter's read loop. */
export interface ChatSink {
  /** Stores one delivery. Resolves when it is stored, and only then may the read position move. */
  deliver(envelope: ChatEnvelope): Promise<void>;
  /** The read position after a batch that was stored whole. */
  save(cursor: ChatCursor): void;
  /** The account cannot be read (a token refused, a webhook in the way) or can again (`undefined`). */
  trouble(trouble: ChatTrouble | undefined): void;
  /** A chat the bot can no longer write to. */
  unreachable(chat: string): void;
}

/** One interface for every chat app. Slack, Discord and email are written against it, not beside it. */
export interface ChatAdapter {
  app: ChatApp;
  capabilities: ChatCapabilities;
  /** Starts the read loop, catching up from `cursor`. Returns what stops it. */
  start(conn: ChatConnection, sink: ChatSink, cursor: ChatCursor | undefined): () => void;
  /** The body in the app's own markup (Telegram HTML, Slack mrkdwn). Slack, Discord and email add a renderer only. */
  render(body: Body, people: People): string;
  /** Writes the message, rendered by this adapter's `render`; falls back to plain words if the app refuses the markup. */
  send(conn: ChatConnection, target: ChatTarget, message: ChatMessage): Promise<{ message: string }>;
  /** Fetches a file now. Refuses one over the size cap. */
  file(conn: ChatConnection, ref: ChatFileRef): Promise<{ path: string; type: string; bytes: number }>;
}

/** A file past this size is not fetched. */
export const FILE_CAP_BYTES = 20 * 1024 * 1024;

/** The app refused a send for a reason that will not change by trying again. */
export class ChatSendError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "needs-token" | "rejected",
  ) {
    super(message);
  }
}
