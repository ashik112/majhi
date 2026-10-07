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
  "brief",
]);
export type NotifyKind = z.infer<typeof NotifyKindSchema>;

export const NOTIFY_KIND_LABEL: Record<NotifyKind, string> = {
  approval: "Approvals",
  question: "Questions",
  secret: "Secret requests",
  review: "Ready to ship",
  stopped: "Stopped or stuck",
  update: "Update failed",
  autonomy: "The captain and Auto-pilot",
  brief: "The morning brief",
};

/**
 * One thing that needs the owner, sent to every open tab (`attention` on `/api/events`). `path` is
 * where it lives in the app. `browser` and `sound` say what the owner's settings allow for this tab.
 * A group ("4 things need you", kind `group`) has `count` above 1 and links to the board.
 */
export const AttentionEventSchema = z.object({
  type: z.literal("attention"),
  id: z.string(),
  kind: z.union([NotifyKindSchema, z.enum(["test", "group", "incident"])]),
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
 * What a tab sends on `/api/events`: whether it can pop browser notifications (the browser granted
 * them), reported on connect and every `BROWSER_TAB_REPORT_MS`; the server counts a report for a
 * minute, so a tab that went away without closing its socket stops counting. And which task the
 * owner types in, so the captain waits (5.18); the server counts that for 15 s.
 */
export const EventsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("browser-notify"), active: z.boolean() }),
  /** The owner types in a task's composer (`task` set), or stopped (no `task`). Repeated every `TYPING_REPORT_MS`. */
  z.object({ type: z.literal("typing"), task: z.string().min(1).max(32).optional() }),
]);
export type EventsClientMessage = z.infer<typeof EventsClientMessageSchema>;
export const BROWSER_TAB_REPORT_MS = 20_000;
export const TYPING_REPORT_MS = 5_000;

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
