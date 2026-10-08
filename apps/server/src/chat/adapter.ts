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
  /** A second token some apps need: Slack's app-level token for Socket Mode. */
  appToken?: string | undefined;
  /** A folder the adapter may write fetched files into. */
  filesDir: string;
  /** Slack: the owner's own token (User OAuth Token). Reading never uses it; sending as the owner does. */
  userToken?: string | undefined;
}

/** Who a user token belongs to, and the scopes it holds when the app says. */
export interface ChatAsYou {
  user: string;
  name: string;
  scopes: string[] | undefined;
}

export interface ChatTarget {
  chat: string;
  thread?: string | undefined;
  replyTo?: string | undefined;
  /** Slack: this chat's replies go out as the owner. With no good user token the send is refused, never made as the bot. */
  asYou?: boolean | undefined;
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
  /** Messages are missing between two times and the adapter could not fetch them: the rooms show a gap. */
  gap?(from: string, to: string): void;
}

/** The channels of a chat app's workspace the bot can see. */
export interface ChatChannelList {
  /** The bot's name, for the invite line. */
  bot: string;
  appId?: string;
  channels: { id: string; name: string; private: boolean; member: boolean }[];
  /** The permissions the token holds, when the app says. */
  scopes: string[] | undefined;
  /** The owner's user token: whose it is, or why it is refused. Absent when none is saved. */
  you?: { state: "ok"; name: string; scopes: string[] | undefined } | { state: "refused"; fix: string };
}

/**
 * What a look at a bot found, as typed facts. The connection's Test turns them into a state; nothing here is text to match.
 * A refused token throws (Telegram 401, Slack `invalid_auth`) and is read by its code.
 */
export type ChatProbe =
  | {
      app: "telegram";
      /** The bot's @name. */
      bot: string;
      canJoinGroups: boolean;
      /** False while group privacy is on: the bot only gets @mentions, commands and replies in groups. */
      readsAllGroupMessages: boolean;
      /** The address of a webhook set on the bot, which blocks `getUpdates`. Undefined when none. */
      webhook: string | undefined;
    }
  | {
      app: "slack";
      bot: string;
      /** The linked channels the bot is not a member of. */
      notIn: { id: string; name: string }[];
    };

/** One interface for every chat app. Slack, Discord and email are written against it, not beside it. */
export interface ChatAdapter {
  app: ChatApp;
  capabilities: ChatCapabilities;
  /** Starts the read loop, catching up from `cursor`. Returns what stops it. */
  start(conn: ChatConnection, sink: ChatSink, cursor: ChatCursor | undefined): () => void;
  /** The body in the app's own markup (Telegram HTML, Slack mrkdwn). Slack, Discord and email add a renderer only. */
  render(body: Body, people: People): string;
  /** Writes the message, rendered by this adapter's `render`; falls back to plain words if the app refuses the markup. */
  send(
    conn: ChatConnection,
    target: ChatTarget,
    message: ChatMessage,
  ): Promise<{ message: string; as?: "you" }>;
  /** Checks the owner's user token (`conn.userToken`) against the same workspace as the bot. Throws a refusal with its fix. */
  asYou?(conn: ChatConnection): Promise<ChatAsYou>;
  /** Asks the app about the bot now: who it is and what keeps it from reading `linked` chats. Throws a refusal. */
  probe?(conn: ChatConnection, linked: readonly string[]): Promise<ChatProbe>;
  /** The channels of the workspace, for the owner's channel picker. Only apps with channels have it. */
  channels?(conn: ChatConnection): Promise<ChatChannelList>;
  /** The bot joins a public channel. Only apps that allow it have it. */
  join?(conn: ChatConnection, channel: string): Promise<void>;
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
    /** Of a refusal for want of a permission: the permission the call needs. */
    readonly needed?: string,
  ) {
    super(message);
  }
}
