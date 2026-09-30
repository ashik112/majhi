import { z } from "zod";
import { TaskIdSchema } from "./tasks.ts";

/**
 * Cleanup of done tasks: what `cleanup.preview` lists and what `cleanup.run` reports.
 * In a preview `action` is what a run would do; in a report it is what was done.
 */
export const CleanupStepSchema = z.object({
  kind: z.enum(["worktree", "branch"]),
  project: z.string(),
  /** The worktree path, or the branch name. */
  name: z.string(),
  action: z.enum(["remove", "skip"]),
  /** Why it is skipped, or how a removal failed. */
  reason: z.string().optional(),
});
export type CleanupStep = z.infer<typeof CleanupStepSchema>;

export const CleanupTaskSchema = z.object({
  id: TaskIdSchema,
  title: z.string(),
  /** When the task was closed. */
  doneAt: z.string(),
  steps: z.array(CleanupStepSchema),
  /** Room items that would be deleted (or were). The cleanup note is not counted. */
  roomItems: z.number().int().nonnegative(),
});
export type CleanupTask = z.infer<typeof CleanupTaskSchema>;

export const CleanupPreviewSchema = z.object({
  days: z.number().int().min(1),
  tasks: z.array(CleanupTaskSchema),
});
export type CleanupPreview = z.infer<typeof CleanupPreviewSchema>;

export const CleanupReportSchema = z.object({
  tasks: z.array(
    CleanupTaskSchema.extend({
      /** Set when the whole task was left alone: it is not done, not old enough, or gone. */
      skipped: z.string().optional(),
    }),
  ),
});
export type CleanupReport = z.infer<typeof CleanupReportSchema>;

export const CleanupRunInputSchema = z.object({
  tasks: z.array(TaskIdSchema).min(1).max(500),
  /** Defaults to the `cleanup.after_days` setting. */
  days: z.number().int().min(1).max(3650).optional(),
});
