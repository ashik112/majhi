import { z } from "zod";

/** What can need the owner. Settings mute these by kind; `test` is only the test button. */
export const NotifyKindSchema = z.enum([
  "approval",
  "question",
  "secret",
  "review",
  "stopped",
  "update",
  "autonomy",
]);
export type NotifyKind = z.infer<typeof NotifyKindSchema>;

export const NOTIFY_KIND_LABEL: Record<NotifyKind, string> = {
  approval: "Approvals",
  question: "Questions",
  secret: "Secret requests",
  review: "Ready for review",
  stopped: "Stopped or stuck",
  update: "Update failed",
  autonomy: "The captain and autonomous mode",
};

/**
 * One thing that needs the owner, sent to every open tab (`attention` on `/api/events`). `path` is
 * where it lives in the app. `browser` and `sound` say what the owner's settings allow for this tab.
 * A group ("4 things need you", kind `group`) has `count` above 1 and links to the board.
 */
export const AttentionEventSchema = z.object({
  type: z.literal("attention"),
  id: z.string(),
  kind: z.union([NotifyKindSchema, z.enum(["test", "group"])]),
  /** Task id, like ACM-12. Absent for a group, a test or an update. */
  task: z.string().optional(),
  title: z.string(),
  /** One line, like "ACM-12 needs approval: run migrations". */
  text: z.string(),
  path: z.string(),
  count: z.number().int().min(1),
  browser: z.boolean(),
  sound: z.boolean(),
});
export type AttentionEvent = z.infer<typeof AttentionEventSchema>;

/**
 * One item that waits for the owner in an open task or chat (`notify.pending`): an approval, a
 * permission, a secret request, a question or a decision. `text` is the line a notification would
 * show, like "ACM-12 needs approval: run migrations".
 */
export const PendingNoticeSchema = z.object({
  task: z.string().min(1),
  /** The room item, so the task can scroll to it. */
  item: z.string().min(1),
  kind: NotifyKindSchema,
  text: z.string(),
  /** When the item appeared (ISO). */
  at: z.string(),
});
export type PendingNotice = z.infer<typeof PendingNoticeSchema>;
