import { z } from "zod";
import { ChatAppSchema } from "./chat.ts";
import { IdSchema } from "./ids.ts";

/**
 * The one list of the Chats page and the chat dock. A conversation is a task's room (`task`), a
 * workspace's captain thread (`captain`), a client's chat (`client`) or a chat the owner started with
 * an agent (`agent`). All are rooms in the same store, so one row shape and one unread rule cover them.
 */
export const ConversationKindSchema = z.enum(["task", "captain", "client", "agent"]);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const ConversationSchema = z.object({
  /** The task id (a task room) or the captain lane's task id (a captain thread). */
  id: z.string().min(1),
  kind: ConversationKindSchema,
  /** The workspace; absent for tasks in Private. */
  org: IdSchema.optional(),
  title: z.string(),
  /** The newest message, owner's or agent's, as one short line. The owner's start with "You: ". */
  lastLine: z.string(),
  /** When that message appeared (ISO). */
  lastAt: z.string(),
  /** Agent messages that appeared after the owner last read this conversation. */
  unread: z.number().int().nonnegative(),
  /** The chat app of a client chat. */
  app: ChatAppSchema.optional(),
  /** The agent of an agent chat. */
  agent: z.string().min(1).optional(),
  /** A client chat the owner unlinked: read only, nothing is read or sent for it. */
  unlinked: z.boolean().optional(),
  /** The owner hid it. It keeps its history and is listed under Archived. */
  archived: z.boolean().optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/** `conversations.search`: the conversations whose messages hold the words, not only their title and last line. */
export const ConversationSearchInputSchema = z.object({ query: z.string().trim().min(2).max(200) });
export const ConversationSearchResultSchema = z.array(z.string().min(1));

/** `conversations.list`: newest message first. */
export const ConversationListSchema = z.array(ConversationSchema);

/**
 * `conversations.markRead`: the owner has seen messages up to `upTo` (the `at` of the newest one on
 * screen). A mark never moves back and never passes the newest agent message.
 */
export const ConversationMarkReadInputSchema = z.object({
  id: z.string().min(1),
  upTo: z.string().min(1),
});
export type ConversationMarkReadInput = z.infer<typeof ConversationMarkReadInputSchema>;

/** `conversations.archive`: hide a conversation from the list (or bring it back). Its history stays. */
export const ConversationArchiveInputSchema = z.object({
  id: z.string().min(1),
  archived: z.boolean(),
});
export type ConversationArchiveInput = z.infer<typeof ConversationArchiveInputSchema>;

/**
 * Pushed on the events socket when one conversation changed (a message arrived, the owner read it).
 * `conversation` is the row as it is now; absent when it is no longer listed. Tabs patch their list
 * with it instead of reading the whole list again.
 */
export const ConversationEventSchema = z.object({
  type: z.literal("conversation"),
  id: z.string().min(1),
  conversation: ConversationSchema.optional(),
});
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
