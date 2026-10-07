import { z } from "zod";
import { ChatMentionSchema } from "./chat-body.ts";
import { IdSchema } from "./ids.ts";

/**
 * Client chats (docs/briefs/client-chats.md): one system for every chat app. A chat app account is a
 * `chat` connection, a client chat is a room of kind `client`, a message is a room item with an
 * external key, and who the client is lives in `contacts`. Nothing here knows one app from another
 * beyond its name: the adapter of an app turns its traffic into the envelope below.
 */

export const CHAT_APPS = ["telegram", "slack", "discord", "email"] as const;
export const ChatAppSchema = z.enum(CHAT_APPS);
export type ChatApp = z.infer<typeof ChatAppSchema>;

export const CHAT_APP_LABEL: Record<ChatApp, string> = {
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  email: "Email",
};

/** The one id of a message in a chat app. A repeat delivery has the same key. */
export const ExternalKeySchema = z.strictObject({
  app: ChatAppSchema,
  /** The bot or mailbox that received it: the connection's account. */
  account: z.string().min(1).max(200),
  chat: z.string().min(1).max(200),
  message: z.string().min(1).max(200),
});
export type ExternalKey = z.infer<typeof ExternalKeySchema>;

/** The key as one string, for the unique index. A JSON array, so no field can run into another. */
export function externalKeyText(key: ExternalKey): string {
  return JSON.stringify([key.app, key.account, key.chat, key.message]);
}

/** A file a message carries, before and after majhi fetched it. */
export const ChatFileRefSchema = z.strictObject({
  /** The app's own id for it, to fetch it. */
  id: z.string().min(1).max(500),
  name: z.string().max(300),
  type: z.string().max(100).optional(),
  bytes: z.number().int().nonnegative().optional(),
});
export type ChatFileRef = z.infer<typeof ChatFileRefSchema>;

export const ChatFileSchema = ChatFileRefSchema.extend({
  /** Where majhi keeps the copy, relative to its chat-files folder. Absent when it was too big or could not be fetched. */
  path: z.string().max(500).optional(),
  /** Why there is no copy. */
  skipped: z.string().max(200).optional(),
});
export type ChatFile = z.infer<typeof ChatFileSchema>;

export const ChatSenderSchema = z.strictObject({
  /** The app's own user id. Identity is this and nothing else: never a name. */
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  bot: z.boolean(),
  /** The handle the app shows for them (Telegram `@name`, without the @), when it has one. It can change. */
  username: z.string().max(200).optional(),
  /** False for an anonymous admin or a sender the app could not name. Never triggers an action. */
  verified: z.boolean().default(true),
});
export type ChatSender = z.infer<typeof ChatSenderSchema>;

export const ChatKindSchema = z.enum(["group", "channel", "private"]);
export type ChatKind = z.infer<typeof ChatKindSchema>;

/** What the adapter knows of the chat a message came in. */
export const ChatInfoSchema = z.strictObject({
  title: z.string().max(300),
  kind: ChatKindSchema,
  people: z.number().int().nonnegative().optional(),
});
export type ChatInfo = z.infer<typeof ChatInfoSchema>;

/** What an adapter hands to majhi for each delivery. The same for every app. */
export const ChatEnvelopeSchema = z.strictObject({
  kind: z.enum(["new", "edit", "delete"]),
  external: ExternalKeySchema,
  chat: ChatInfoSchema,
  sender: ChatSenderSchema,
  text: z.string().max(100_000),
  files: z.array(ChatFileRefSchema).max(20),
  at: z.string(),
  thread: z.string().max(200).optional(),
  replyTo: z.string().max(200).optional(),
  forwarded: z.boolean().optional(),
  /** The people the text names, as the app marks them. */
  mentions: z.array(ChatMentionSchema).max(200).optional(),
  /** The chat moved to another id (a Telegram group became a supergroup): `external.chat` is the old id. */
  movedTo: z.string().max(200).optional(),
});
export type ChatEnvelope = z.infer<typeof ChatEnvelopeSchema>;

/** Where Telegram's own state is kept in a connection's runtime state. */
export const ChatCursorSchema = z.strictObject({
  /** Telegram's offset, Slack's latest ts per channel: whatever the app needs to continue. */
  position: z.record(z.string(), z.string()),
  /** When the last batch was stored. A gap longer than the app keeps is shown in the rooms. */
  at: z.string(),
});
export type ChatCursor = z.infer<typeof ChatCursorSchema>;

/** Why a chat or a connection is not working. */
export const ChatTroubleSchema = z.enum(["unreachable", "needs-token", "webhook"]);
export type ChatTrouble = z.infer<typeof ChatTroubleSchema>;

// ---------------------------------------------------------------------------
// Rooms

/** Who writes to the client: the captain, or the owner (and teammates). One holder per room. */
export const ChatHolderSchema = z.enum(["captain", "you"]);
export type ChatHolder = z.infer<typeof ChatHolderSchema>;

/** The chat a client room is, stored on its task row. `ignored` rooms drop what arrives. */
export const ClientRoomSchema = z.strictObject({
  app: ChatAppSchema,
  account: z.string().min(1).max(200),
  chat: z.string().min(1).max(200),
  title: z.string().max(300),
  kind: ChatKindSchema,
  people: z.number().int().nonnegative().optional(),
  holder: ChatHolderSchema.default("captain"),
  ignored: z.boolean().optional(),
  trouble: ChatTroubleSchema.optional(),
});
export type ClientRoom = z.infer<typeof ClientRoomSchema>;

/** One row of the Clients list (a linked chat) or of New chats (not linked yet). */
export const ClientRowSchema = z.object({
  /** The room's id (a task id). */
  id: z.string().min(1),
  app: ChatAppSchema,
  title: z.string(),
  kind: ChatKindSchema,
  people: z.number().int().nonnegative().optional(),
  /** The workspace; absent in New chats. */
  org: IdSchema.optional(),
  holder: ChatHolderSchema,
  trouble: ChatTroubleSchema.optional(),
  /** The newest line and when. Absent until a message is stored. */
  lastLine: z.string().optional(),
  lastAt: z.string().optional(),
  unread: z.number().int().nonnegative(),
  /** A reply waits for the owner. */
  waiting: z.boolean(),
});
export type ClientRow = z.infer<typeof ClientRowSchema>;

/** A chat app account majhi reads, and whether it can be. */
export const ChatAccountSchema = z.object({
  connection: IdSchema,
  org: IdSchema,
  app: ChatAppSchema,
  account: z.string(),
  trouble: ChatTroubleSchema.optional(),
});
export type ChatAccount = z.infer<typeof ChatAccountSchema>;

export const ClientListSchema = z.object({
  clients: z.array(ClientRowSchema),
  newChats: z.array(ClientRowSchema),
  accounts: z.array(ChatAccountSchema),
});
export type ClientList = z.infer<typeof ClientListSchema>;

export const ChatLinkInputSchema = z.object({ room: z.string().min(1), org: IdSchema });
export const ChatIgnoreInputSchema = z.object({ room: z.string().min(1) });

/** One channel of a chat app's workspace, as the channel picker shows it. */
export const ChatChannelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  private: z.boolean(),
  /** Whether the bot is in it now. */
  member: z.boolean(),
  /** The room majhi made for it, once there is one. */
  room: z.string().optional(),
  /** The workspace it is linked to. */
  org: IdSchema.optional(),
  ignored: z.boolean().optional(),
});
export type ChatChannel = z.infer<typeof ChatChannelSchema>;

export const ChatChannelsSchema = z.object({
  connection: IdSchema,
  /** The bot's name, for the `/invite @name` line. */
  bot: z.string(),
  /** The app's page of permissions, when majhi knows the app. */
  appId: z.string().optional(),
  channels: z.array(ChatChannelSchema),
  /** Permissions majhi needs that the connection lacks. Empty when none, or when the app does not say. */
  missingScopes: z.array(z.string()),
});
export type ChatChannels = z.infer<typeof ChatChannelsSchema>;

export const ChatChannelsInputSchema = z.object({ connection: IdSchema, refresh: z.boolean().optional() });
export const ChatChannelLinkInputSchema = z.object({
  connection: IdSchema,
  channel: z.string().min(1),
  org: IdSchema,
});
export const ChatChannelIgnoreInputSchema = z.object({ connection: IdSchema, channel: z.string().min(1) });

/** The Slack permissions majhi needs beyond reading messages: files, group chats and joining public channels. */
export const SLACK_NEEDED_SCOPES = ["files:read", "mpim:read", "channels:join"] as const;
export const ChatHolderInputSchema = z.object({ room: z.string().min(1), holder: ChatHolderSchema });
export const ChatSendInputSchema = z.object({
  room: z.string().min(1),
  text: z.string().trim().min(1).max(20_000),
  /** The message it answers, for the app's reply link. */
  replyTo: z.string().max(200).optional(),
});
export const ChatEditReplyInputSchema = z.object({
  draft: z.number().int().positive(),
  text: z.string().trim().min(1).max(20_000),
});
/** The owner says a sender is one of us (the owner or a teammate), or is not. */
export const ChatMarkUsInputSchema = z.object({
  room: z.string().min(1),
  /** A message of the sender. */
  item: z.string().min(1),
  us: z.boolean(),
});
export const ChatRoomInputSchema = z.object({ room: z.string().min(1) });

/** What a room needs beyond its items: the chat, its workspace and its state. */
export const ClientRoomViewSchema = z.object({
  room: z.string(),
  org: IdSchema.optional(),
  chat: ClientRoomSchema,
});
export type ClientRoomView = z.infer<typeof ClientRoomViewSchema>;

// ---------------------------------------------------------------------------
// Contacts

export const ContactSchema = z.object({
  id: z.string().min(1),
  org: IdSchema,
  name: z.string().min(1).max(200),
  tz: z.string().max(64).optional(),
  lang: z.string().max(16).optional(),
  /** A teammate or the owner: their messages in a room are "us". */
  us: z.boolean().default(false),
});
export type Contact = z.infer<typeof ContactSchema>;

export const ContactIdSchema = z.strictObject({
  app: ChatAppSchema,
  account: z.string().min(1).max(200),
  /** The app's own user id. */
  native: z.string().min(1).max(200),
  /** The handle the app shows for them, when it has one. It can change: refreshed on each message. */
  username: z.string().max(200).optional(),
});
export type ContactIdentity = z.infer<typeof ContactIdSchema>;

export const ContactViewSchema = ContactSchema.extend({ ids: z.array(ContactIdSchema) });
export type ContactView = z.infer<typeof ContactViewSchema>;

export const ContactMergeInputSchema = z.object({ keep: z.string().min(1), merge: z.string().min(1) });
export const ContactUndoInputSchema = z.object({ merge: z.number().int().positive() });
export const ContactMergeResultSchema = z.object({
  merge: z.number().int().positive(),
  contact: ContactViewSchema,
});

/** The owner's answer to a "same person?" card. */
export const SamePersonAnswerInputSchema = z.object({
  room: z.string().min(1),
  item: z.string().min(1),
  answer: z.enum(["same", "not-same"]),
});

// ---------------------------------------------------------------------------
// What the captain may do without asking

/**
 * What the owner holds for themselves even when the captain decides Tell (docs/briefs/client-chats.md,
 * "Permission"). Each can be switched off by the owner; all are on until then. Two more always hold and
 * have no switch: a reply with a secret, and a reply that names another client or another workspace's data.
 */
export const HOLD_CLASSES = [
  "promisedTime",
  "firstContact",
  "severalClients",
  "afterGap",
  "money",
  "security",
] as const;
export const HoldClassSchema = z.enum(HOLD_CLASSES);
export type HoldClass = z.infer<typeof HoldClassSchema>;

export const HOLD_LABEL: Record<HoldClass, string> = {
  promisedTime: "Promised times",
  firstContact: "First message to a contact",
  severalClients: "A group with several clients",
  afterGap: "Anything after a gap",
  money: "Money or contract",
  security: "Security incident",
};

/** The fixed holds: they have no switch. */
export const FixedHoldSchema = z.enum(["secret", "other-client", "report", "unchecked"]);
export type FixedHold = z.infer<typeof FixedHoldSchema>;

/** The Hold list of a workspace: `false` switches a class off. Absent means on. */
export const HoldsSchema = z.strictObject({
  promisedTime: z.boolean(),
  firstContact: z.boolean(),
  severalClients: z.boolean(),
  afterGap: z.boolean(),
  money: z.boolean(),
  security: z.boolean(),
});
export type Holds = z.infer<typeof HoldsSchema>;

export const HoldsPatchSchema = HoldsSchema.partial();
export type HoldsPatch = z.infer<typeof HoldsPatchSchema>;

/** Every class on, then what the owner switched off. */
export function effectiveHolds(stored: HoldsPatch | undefined): Holds {
  return {
    promisedTime: stored?.promisedTime ?? true,
    firstContact: stored?.firstContact ?? true,
    severalClients: stored?.severalClients ?? true,
    afterGap: stored?.afterGap ?? true,
    money: stored?.money ?? true,
    security: stored?.security ?? true,
  };
}

/** What a reply the captain wrote says about itself. The writer states it; a missing flag holds the reply. */
export const ReplyFlagsSchema = z.strictObject({
  promisedTime: z.boolean(),
  money: z.boolean(),
  security: z.boolean(),
  /** The message or the group shows more than one client company. */
  severalClients: z.boolean(),
});
export type ReplyFlags = z.infer<typeof ReplyFlagsSchema>;

export const ReplyHoldSchema = z.union([HoldClassSchema, FixedHoldSchema, z.literal("tell")]);
export type ReplyHold = z.infer<typeof ReplyHoldSchema>;

/** The line a held reply shows beside "Reply waits for you": what in the reply made it wait. */
export const REPLY_HOLD_LABEL: Record<ReplyHold, string> = {
  tell: "You decide replies here",
  secret: "Holds a secret",
  "other-client": "Names another client",
  report: "A report to a client",
  unchecked: "Not checked",
  promisedTime: "Mentions a time",
  firstContact: "First message to them",
  severalClients: "Several clients in the chat",
  afterGap: "After a gap in delivery",
  money: "Mentions money",
  security: "Security incident",
};

/** The captain writes to a client chat. It states what the text says about itself: a missing statement holds the reply. */
export const ChatReplyInputSchema = ReplyFlagsSchema.extend({
  room: z.string().min(1),
  text: z.string().trim().min(1).max(4000),
  /** The message it answers: the sender's user id and the message id. */
  to: z.string().max(200).optional(),
  replyTo: z.string().max(200).optional(),
  thread: z.string().max(200).optional(),
});
export const ChatReplyResultSchema = z.object({
  state: z.enum(["sent", "held", "failed"]),
  /** Why it waits, in the owner's words. */
  why: z.string().optional(),
});

export type ChatReplyInput = z.infer<typeof ChatReplyInputSchema>;

/** What a client message says about itself, as the triage step reports it: no tools, only these answers. */
export const TRIAGE_ACTIONS = ["ignore", "answer", "ask", "attach", "update", "task"] as const;
export const TriageActionSchema = z.enum(TRIAGE_ACTIONS);
export type TriageAction = z.infer<typeof TriageActionSchema>;
