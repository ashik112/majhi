import { z } from "zod";
import { IdSchema, MergePolicySchema } from "./accounts.ts";
import { TaskIdSchema, TaskSchema } from "./tasks.ts";

/**
 * Results of the merge request commands (SPEC 5.5). The state itself lives on each task repo
 * (`Task.repos[].mr`, `pushedAt`, `mergeOrder`); these say what one command did.
 */

/** What `tasks.openMrs` did for one repo. */
export const OpenMrOutcomeSchema = z.enum([
  /** Pushed, and a new MR is open. */
  "opened",
  /** The MR was already open: pushed again and the description refreshed. */
  "updated",
  /** Nothing to send: the branch has no commit past its base. */
  "skipped",
  "failed",
]);

export const OpenMrsResultSchema = z.object({
  task: TaskSchema,
  repos: z.array(
    z.object({
      project: IdSchema,
      outcome: OpenMrOutcomeSchema,
      url: z.string().optional(),
      /** One plain line for the room: what happened, or why not. */
      detail: z.string(),
    }),
  ),
});
export type OpenMrsResult = z.infer<typeof OpenMrsResultSchema>;

export const MergeOrderSchema = z.object({
  /** Projects of the task's repos, first to merge first. */
  order: z.array(IdSchema),
  /** True when the owner set it (`tasks.setMergeOrder`) instead of the links. */
  overridden: z.boolean(),
});
export type MergeOrder = z.infer<typeof MergeOrderSchema>;

export const RefreshMrsResultSchema = z.object({
  task: TaskSchema,
  policy: MergePolicySchema,
});
export type RefreshMrsResult = z.infer<typeof RefreshMrsResultSchema>;

export const MergeMrsResultSchema = z.object({
  task: TaskSchema,
  /** Projects this call merged, in order. */
  merged: z.array(IdSchema),
  /** Where it stopped and why; absent when every MR is merged. */
  stoppedAt: z.object({ project: IdSchema, reason: z.string() }).optional(),
  /** True when every MR is merged and the task is done. */
  done: z.boolean(),
});
export type MergeMrsResult = z.infer<typeof MergeMrsResultSchema>;

export const MarkMergedResultSchema = z.object({
  task: TaskSchema,
  /** Repos whose MR the host still shows as not merged, when the owner did not force it. */
  stillOpen: z.array(z.object({ project: IdSchema, state: z.string() })),
  done: z.boolean(),
});
export type MarkMergedResult = z.infer<typeof MarkMergedResultSchema>;

export const MrTaskInputSchema = z.object({ id: TaskIdSchema });

/** One file of a repo's change, as git shows it: the patch is git's own unified diff text. */
export const RepoDiffFileSchema = z.object({
  path: z.string(),
  /** Where the file was before, for a rename. */
  oldPath: z.string().optional(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  /** Hunks only, from the first `@@`. Empty for a binary file or when it was cut. */
  patch: z.string(),
  /** True when the patch was left out for size. */
  truncated: z.boolean(),
});
export type RepoDiffFile = z.infer<typeof RepoDiffFileSchema>;

/** What one repo of a task changed against its base: commits and uncommitted work together. */
export const RepoDiffSchema = z.object({
  project: IdSchema,
  base: z.string(),
  branch: z.string(),
  files: z.array(RepoDiffFileSchema),
  /** Files past the cap that are not listed. */
  omitted: z.number().int().nonnegative(),
  /** True when the worktree has changes that are not committed (they are in `files`). */
  uncommitted: z.boolean(),
  /** Set when the diff could not be read, with the reason. */
  error: z.string().optional(),
});
export type RepoDiff = z.infer<typeof RepoDiffSchema>;
