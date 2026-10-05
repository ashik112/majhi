import { z } from "zod";
import { HandoffActivitySchema, HandoffStatusSchema, HandoffStepIdSchema } from "./handoff.ts";
import { MergeChecksSchema } from "./merge-checks.ts";

/**
 * What Home reads about a review task's checks, from structured data only: the merge gate's verdict,
 * what the hand-off is doing now, and the step the verdict names with its timing. Nothing here is text
 * to be matched.
 */
export const HomeCheckSchema = z.object({
  task: z.string(),
  /** The merge gate's answer for the task's head now. */
  checks: MergeChecksSchema,
  /** Set while a check of the task runs or waits for a slot. */
  activity: HandoffActivitySchema.optional(),
  /** The first sentence of the agent's last message in the task: what it says it did. */
  outcome: z.string().optional(),
  /** The step the verdict names when it failed, as the hand-off recorded it. */
  failedStep: z
    .object({
      id: HandoffStepIdSchema,
      status: HandoffStatusSchema,
      ms: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type HomeCheck = z.infer<typeof HomeCheckSchema>;

/** Work that runs without an agent turn: a hand-off check, a task's background process, a preview. */
export const HOME_BACKGROUND_KINDS = [
  "check",
  "queued-check",
  "process",
  "build",
  "preview",
  "service",
] as const;
export const HomeBackgroundSchema = z.object({
  task: z.string(),
  kind: z.enum(HOME_BACKGROUND_KINDS),
  /** The step of a check ("tests"), or the name of a process, build, preview or service. */
  label: z.string(),
  /** When it started (UTC ISO). */
  since: z.string(),
  /** Place in the queue, 1 is next. Only for `queued-check`. */
  position: z.number().int().positive().optional(),
});
export type HomeBackground = z.infer<typeof HomeBackgroundSchema>;
