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
  /** The app lists them as an owner or admin of the workspace or the chat: someone who may be one of us. */
  staff: z.boolean().optional(),
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
  /** The message names the bot (a mention of it) or answers one of its messages: it is addressed to us. */
  addressed: z.boolean().optional(),
  /** The account of the owner wrote it (Slack: the user token's user), typed in the app, not sent by majhi. */
  owner: z.boolean().optional(),
  /** The chat moved to another id (a Telegram group became a supergroup): `external.chat` is the old id. */
  movedTo: z.string().max(200).optional(),
});
export type ChatEnvelope = z.infer<typeof ChatEnvelopeSchema>;

/**
 * What became of a client message, kept on the message itself and drawn as one faint line under it. `replied`,
 * `waits` and `failed` with a `draft` are read live from that reply (sent, held, failed), so the line stays true
 * when the owner sends or discards a held one.
 */
export const ClientOutcomeSchema = z.strictObject({
  state: z.enum(["working", "replied", "ignored", "waits", "failed", "handled", "skipped"]),
  why: z.string().max(400).optional(),
  draft: z.number().int().positive().optional(),
  /** Laya read it as urgent: the owner is told whatever the chat's Notify setting says. */
  urgent: z.boolean().optional(),
  /** The task or incident it became or joined: the line links to it. */
  task: z.string().max(100).optional(),
});
export type ClientOutcome = z.infer<typeof ClientOutcomeSchema>;

/** Where Telegram's own state is kept in a connection's runtime state. */
export const ChatCursorSchema = z.strictObject({
  /** Telegram's offset, Slack's latest ts per channel: whatever the app needs to continue. */
  position: z.record(z.string(), z.string()),
  /** When the last batch was stored. A gap longer than the app keeps is shown in the rooms. */
  at: z.string(),
  /** Slack: permissions the app refused a call for, until a later read of its scopes shows them granted. */
  needed: z.array(z.string()).optional(),
  /** Slack: a message event has arrived on this connection. */
  eventSeen: z.boolean().optional(),
});
export type ChatCursor = z.infer<typeof ChatCursorSchema>;

/** Why a chat or a connection is not working. */
export const ChatTroubleSchema = z.enum(["unreachable", "needs-token", "webhook"]);
export type ChatTrouble = z.infer<typeof ChatTroubleSchema>;

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
  promisedTime: "A reply that promises a time",
  firstContact: "The first reply to someone new",
  severalClients: "A chat with more than one client",
  afterGap: "Replies after majhi was offline",
  money: "A reply about money or a contract",
  security: "A reply about a security incident",
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

// ---------------------------------------------------------------------------
// Rooms

/** Who writes to the client: the captain, or the owner (and teammates). One holder per room. */
export const ChatHolderSchema = z.enum(["captain", "you"]);
export type ChatHolder = z.infer<typeof ChatHolderSchema>;

/** When the captain reads a message of the chat: only those that name it, those that need a reply, or all. */
export const REPLY_WHEN = ["mentioned", "needs-reply", "every"] as const;
export const ReplyWhenSchema = z.enum(REPLY_WHEN);
export type ReplyWhen = z.infer<typeof ReplyWhenSchema>;
export const DEFAULT_REPLY_WHEN: ReplyWhen = "needs-reply";

/** The captain's replies a day in one chat. "none": no limit. */
export const REPLY_LIMITS = [20, 50, 100, "none"] as const;
export const ReplyLimitSchema = z.union([z.literal(20), z.literal(50), z.literal(100), z.literal("none")]);
export type ReplyLimit = z.infer<typeof ReplyLimitSchema>;
export const DEFAULT_REPLY_LIMIT: ReplyLimit = 50;

/** How much of a chat majhi keeps: all, or the newest 500 or 100 messages. */
export const KEEP_CHOICES = ["all", 500, 100] as const;
export const KeepSchema = z.union([z.literal("all"), z.literal(500), z.literal(100)]);
export type Keep = z.infer<typeof KeepSchema>;

/** When the owner is told of a message: when it needs them, for every one, or never. Urgent always tells. */
export const NOTIFY_CHOICES = ["needs-me", "every", "never"] as const;
export const NotifySchema = z.enum(NOTIFY_CHOICES);
export type Notify = z.infer<typeof NotifySchema>;

/** The longest rules text of a chat. */
export const CHAT_RULES_MAX = 1500;

/** The chat a client room is, stored on its task row. `ignored` rooms drop what arrives. */
export const ClientRoomSchema = z.strictObject({
  app: ChatAppSchema,
  account: z.string().min(1).max(200),
  chat: z.string().min(1).max(200),
  title: z.string().max(300),
  kind: ChatKindSchema,
  people: z.number().int().nonnegative().optional(),
  holder: ChatHolderSchema.default("captain"),
  /** Slack: whose name replies in this chat go out under. Me needs the owner's user token on the connection. */
  sendAs: z.enum(["bot", "me"]).default("bot"),
  /** The chat's own settings (the sheet "Chat settings"). Absent: the default, or the workspace's. */
  replyWhen: ReplyWhenSchema.optional(),
  dailyLimit: ReplyLimitSchema.optional(),
  /** The owner's instructions for this chat. They never loosen the Ask-me cases or the fixed holds. */
  rules: z.string().max(CHAT_RULES_MAX).optional(),
  /** Ask-me cases set for this chat: true asks the owner, false lets the captain send. Unset: the workspace's. */
  holds: HoldsPatchSchema.optional(),
  keep: KeepSchema.optional(),
  notify: NotifySchema.optional(),
  /** Senders (the app's user ids) whose messages are stored and never read by the captain. */
  muted: z.array(z.string().min(1).max(200)).max(500).optional(),
  ignored: z.boolean().optional(),
  /** Unlinked by the owner: its history stays under its workspace, read only, and nothing is read or sent. */
  archived: z.boolean().optional(),
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
  /** Whose name replies go out under (Slack): the bot, or the owner. */
  sendAs: z.enum(["bot", "me"]),
  trouble: ChatTroubleSchema.optional(),
  /** Unlinked: shown read only under its workspace. */
  archived: z.boolean().optional(),
  /** The newest line and when. Absent until a message is stored. */
  lastLine: z.string().optional(),
  lastAt: z.string().optional(),
  unread: z.number().int().nonnegative(),
  /** A reply waits for the owner. */
  waiting: z.boolean(),
  /** The owner chose not to read it. Only the connection's group list shows such a row. */
  ignored: z.boolean().optional(),
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

/** `chat.groups`: the groups and channels of one connection's account, ignored ones too. */
export const ChatGroupsInputSchema = z.object({ connection: IdSchema });
export const ChatGroupsSchema = z.array(ClientRowSchema);

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

/** What is known of a permission: held, refused, or not told. Never a silent pass. */
export const ChatPermissionStateSchema = z.enum(["granted", "missing", "unknown"]);
export type ChatPermissionState = z.infer<typeof ChatPermissionStateSchema>;

export const ChatPermissionSchema = z.object({
  scope: z.string(),
  /** Who needs it: the bot, the owner's user token (Send as Me), or both. One row per scope. */
  who: z.array(z.enum(["bot", "you"])).min(1),
  /** What it is for, in a few words. */
  use: z.string(),
  /** Missing when any holder lacks it. */
  state: ChatPermissionStateSchema,
  /** Of a missing permission: who lacks it. */
  lacking: z.array(z.enum(["bot", "you"])).optional(),
});
export type ChatPermission = z.infer<typeof ChatPermissionSchema>;

/** Whose name Slack replies go out under. */
export const ChatSendAsSchema = z.enum(["bot", "me"]);
export type ChatSendAs = z.infer<typeof ChatSendAsSchema>;

/** The owner's user token: none saved, accepted (and whose it is), or refused with the step that fixes it. */
export const ChatYouSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  z.object({ state: z.literal("ok"), name: z.string() }),
  z.object({ state: z.literal("refused"), fix: z.string() }),
]);
export type ChatYou = z.infer<typeof ChatYouSchema>;

export const ChatChannelsSchema = z.object({
  connection: IdSchema,
  /** The bot's name, for the `/invite @name` line. */
  bot: z.string(),
  /** The app's page of permissions, when majhi knows the app. */
  appId: z.string().optional(),
  channels: z.array(ChatChannelSchema),
  /** Every permission majhi needs, with what is known of it. */
  permissions: z.array(ChatPermissionSchema),
  /** Whether Socket Mode is on, from the connection's check. */
  socketMode: ChatPermissionStateSchema,
  /** A message event has arrived on this connection. */
  messageEvents: z.boolean(),
  /** The user token that makes "Me" possible. */
  you: ChatYouSchema,
  /** The app manifest majhi would use, as JSON the owner pastes under App Manifest. */
  manifest: z.string(),
});
export type ChatChannels = z.infer<typeof ChatChannelsSchema>;

/** Save the owner's User OAuth Token on a Slack connection, after checking it. */
export const ChatUserTokenInputSchema = z.object({
  connection: IdSchema,
  userToken: z.string().trim().min(1).max(500),
});
/** Choose Bot or Me for one client chat. */
export const ChatSendAsInputSchema = z.object({ room: z.string().min(1), sendAs: ChatSendAsSchema });

export const ChatChannelsInputSchema = z.object({ connection: IdSchema, refresh: z.boolean().optional() });
export const ChatChannelLinkInputSchema = z.object({
  connection: IdSchema,
  channel: z.string().min(1),
  org: IdSchema,
});
export const ChatChannelIgnoreInputSchema = z.object({ connection: IdSchema, channel: z.string().min(1) });

export const ChatUnlinkInputSchema = z.object({ room: z.string().min(1) });
export const ChatUnignoreInputSchema = z.object({ room: z.string().min(1) });
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
export const WhoIsAnswerInputSchema = z.object({
  room: z.string().min(1),
  item: z.string().min(1),
  answer: z.enum(["us", "client"]),
});

export const SamePersonAnswerInputSchema = z.object({
  room: z.string().min(1),
  item: z.string().min(1),
  answer: z.enum(["same", "not-same"]),
});

// ---------------------------------------------------------------------------
// What the captain may do without asking

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

export const ReplyHoldSchema = z.union([
  HoldClassSchema,
  FixedHoldSchema,
  z.literal("tell"),
  /** The chat's replies for the day were all sent. */
  z.literal("limit"),
]);
export type ReplyHold = z.infer<typeof ReplyHoldSchema>;

/** The line a held reply shows beside "Reply waits for you": what in the reply made it wait. */
export const REPLY_HOLD_LABEL: Record<ReplyHold, string> = {
  tell: "Tell is set to You",
  limit: "Daily limit reached",
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

// ---------------------------------------------------------------------------
// Chat settings (the sheet opened from a client room's header)

/** What the chat's settings are when the owner set nothing: the default of each, filled in. */
export interface ChatRoomSettings {
  replyWhen: ReplyWhen;
  sendAs: "bot" | "me";
  dailyLimit: ReplyLimit;
  rules: string;
  /** The Ask-me cases set for this chat only. */
  holds: HoldsPatch;
  keep: Keep;
  notify: Notify;
}

export function chatRoomSettings(chat: ClientRoom): ChatRoomSettings {
  return {
    replyWhen: chat.replyWhen ?? DEFAULT_REPLY_WHEN,
    sendAs: chat.sendAs,
    dailyLimit: chat.dailyLimit ?? DEFAULT_REPLY_LIMIT,
    rules: chat.rules ?? "",
    holds: chat.holds ?? {},
    keep: chat.keep ?? "all",
    notify: chat.notify ?? "needs-me",
  };
}

/** The Ask-me list that applies to a chat: the workspace's, with the cases the chat sets for itself. */
export function holdsForRoom(workspace: Holds, chat: ClientRoom): Holds {
  const own = chat.holds;
  return {
    promisedTime: own?.promisedTime ?? workspace.promisedTime,
    firstContact: own?.firstContact ?? workspace.firstContact,
    severalClients: own?.severalClients ?? workspace.severalClients,
    afterGap: own?.afterGap ?? workspace.afterGap,
    money: own?.money ?? workspace.money,
    security: own?.security ?? workspace.security,
  };
}

/** Why "Me" cannot be chosen in a chat of an app, or undefined when it can. */
export function sendAsMeProblem(app: ChatApp, kind: ChatKind): string | undefined {
  if (app === "telegram" && kind !== "private") return "Telegram bots cannot post as you in groups";
  if (app !== "slack" && app !== "telegram") return `${CHAT_APP_LABEL[app]} cannot post as you`;
  return undefined;
}

export const PERSON_ROLES = ["client", "us", "muted"] as const;
export const PersonRoleSchema = z.enum(PERSON_ROLES);
export type PersonRole = z.infer<typeof PersonRoleSchema>;

export const ChatPersonSchema = z.object({
  /** The app's user id: the sender's identity. */
  id: z.string(),
  name: z.string(),
  role: PersonRoleSchema,
  /** Whether the sender can be one of us: only a verified sender has a contact to mark. */
  canUs: z.boolean(),
});
export type ChatPerson = z.infer<typeof ChatPersonSchema>;

export const ChatSettingsViewSchema = z.object({
  room: z.string(),
  title: z.string(),
  app: ChatAppSchema,
  kind: ChatKindSchema,
  org: IdSchema,
  holder: ChatHolderSchema,
  replyWhen: ReplyWhenSchema,
  sendAs: z.enum(["bot", "me"]),
  dailyLimit: ReplyLimitSchema,
  rules: z.string(),
  keep: KeepSchema,
  notify: NotifySchema,
  /** The Ask-me cases this chat sets itself. */
  holds: HoldsPatchSchema,
  /** The workspace's Ask-me list, which the other cases follow. */
  workspaceHolds: HoldsSchema,
  /** Whether "Me" can be chosen here, and why not. */
  me: z.object({ allowed: z.boolean(), why: z.string().optional() }),
  /** The captain's replies sent today in the workspace's time zone. */
  repliesToday: z.number().int().nonnegative(),
  people: z.array(ChatPersonSchema),
  archived: z.boolean().optional(),
});
export type ChatSettingsView = z.infer<typeof ChatSettingsViewSchema>;

/** A change to the Ask-me cases of one chat: `null` follows the workspace again. */
export const ChatHoldsChangeSchema = z.strictObject({
  promisedTime: z.boolean().nullable().optional(),
  firstContact: z.boolean().nullable().optional(),
  severalClients: z.boolean().nullable().optional(),
  afterGap: z.boolean().nullable().optional(),
  money: z.boolean().nullable().optional(),
  security: z.boolean().nullable().optional(),
});

/** What the owner changes in the sheet: only the fields named. Who replies now is `chat.holder`. */
export const ChatSettingsInputSchema = z.strictObject({
  room: z.string().min(1),
  replyWhen: ReplyWhenSchema.optional(),
  dailyLimit: ReplyLimitSchema.optional(),
  /** Empty clears it. A secret in it is refused. */
  rules: z.string().max(CHAT_RULES_MAX).optional(),
  holds: ChatHoldsChangeSchema.optional(),
  keep: KeepSchema.optional(),
  notify: NotifySchema.optional(),
});
export type ChatSettingsInput = z.infer<typeof ChatSettingsInputSchema>;

export const ChatKeepCountInputSchema = z.object({ room: z.string().min(1), keep: KeepSchema });
export const ChatKeepCountSchema = z.object({ remove: z.number().int().nonnegative() });

export const ChatPersonInputSchema = z.object({
  room: z.string().min(1),
  /** The sender's user id in the app. */
  sender: z.string().min(1).max(200),
  role: PersonRoleSchema,
});
