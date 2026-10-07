import { z } from "zod";
import { IdSchema } from "./ids.ts";

/**
 * The chat dock: the conversations the owner can read replies in without leaving a page. A
 * conversation is a task's room (`task`) or a workspace's captain thread (`captain`). Both are rooms
 * in the same store, so one row shape and one unread rule cover them. The owner's own chats on the
 * Chats page are not conversations here.
 */
export const ConversationKindSchema = z.enum(["task", "captain", "client"]);
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
});
export type Conversation = z.infer<typeof ConversationSchema>;

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
