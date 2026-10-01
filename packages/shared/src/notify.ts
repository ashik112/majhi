import { z } from "zod";

/** What can need the owner. Settings mute these by kind; `test` is only the test button. */
export const NotifyKindSchema = z.enum(["approval", "question", "secret", "review", "stopped", "update"]);
export type NotifyKind = z.infer<typeof NotifyKindSchema>;

export const NOTIFY_KIND_LABEL: Record<NotifyKind, string> = {
  approval: "Approvals",
  question: "Questions",
  secret: "Secret requests",
  review: "Ready for review",
  stopped: "Stopped or stuck",
  update: "Update failed",
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
