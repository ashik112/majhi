import { z } from "zod";

/**
 * The project knowledge card (SPEC 5.18, captain v2 step 5): what majhi knows about a repo, read by
 * cheap code from its files and refreshed when the base branch moves. One card per project, with a
 * readiness score for working in it with agents.
 */

/** The commands a repo documents for itself, as a shell line to run in its root. */
export const CardCommandsSchema = z.object({
  install: z.string().optional(),
  run: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
  lint: z.string().optional(),
  typecheck: z.string().optional(),
  format: z.string().optional(),
});
export type CardCommands = z.infer<typeof CardCommandsSchema>;

export const READINESS_IDS = ["base", "test", "checks", "ci", "docs", "worktree"] as const;
export const ReadinessIdSchema = z.enum(READINESS_IDS);
export type ReadinessId = z.infer<typeof ReadinessIdSchema>;

/** One line of the readiness checklist. A missing one carries the task that would fix it. */
export const ReadinessItemSchema = z.object({
  id: ReadinessIdSchema,
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  fix: z.string().optional(),
});
export type ReadinessItem = z.infer<typeof ReadinessItemSchema>;

export const ReadinessSchema = z.object({
  /** 0 to 5: the scored items that hold. 0 when the base branch is unknown. */
  score: z.number().int().min(0).max(5),
  max: z.literal(5),
  items: z.array(ReadinessItemSchema),
});
export type Readiness = z.infer<typeof ReadinessSchema>;

export const ProjectCardSchema = z.object({
  project: z.string(),
  org: z.string(),
  /** The base branch's tip the card was read at, and the branch. */
  commit: z.string().optional(),
  base: z.string().optional(),
  refreshedAt: z.string(),
  /** One paragraph. From the model when it ran, else the start of the README. */
  whatItIs: z.string(),
  whatItIsBy: z.enum(["model", "readme", "none"]),
  stack: z.array(z.string()),
  commands: CardCommandsSchema,
  structure: z.array(z.object({ path: z.string(), note: z.string() })),
  conventions: z.array(z.string()),
  ci: z.object({ provider: z.string().optional(), workflows: z.array(z.string()) }),
  deploy: z.array(z.string()),
  remotes: z.array(z.object({ name: z.string(), url: z.string() })),
  aliases: z.array(z.string()),
  readiness: ReadinessSchema,
});
export type ProjectCard = z.infer<typeof ProjectCardSchema>;
