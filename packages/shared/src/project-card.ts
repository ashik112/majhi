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

/**
 * One check the repo's own CI runs, as the hand-off check runs it: the command, the environment and the
 * folder of the CI job, and where it was read from.
 */
export const CardCheckSchema = z.object({
  kind: z.enum(["lint", "typecheck", "test", "build"]),
  command: z.string(),
  env: z.record(z.string(), z.string()),
  /** The folder it runs in, relative to the repo root. Absent: the root. */
  workdir: z.string().optional(),
  /** "from .gitlab-ci.yml job build". */
  from: z.string(),
  /** The minutes the CI gives the job, when it says. */
  minutes: z.number().optional(),
  /** Services the CI job starts next to it, like a database image. */
  services: z.array(z.string()),
  /** The line the check runs: `command` in its read-only form, when that differs from it. */
  runs: z.string().optional(),
  /** Why majhi does not run this check (a script that changes files in steps it cannot make read-only). */
  notRun: z.string().optional(),
});
export type CardCheck = z.infer<typeof CardCheckSchema>;

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
  /** The checks the repo's CI runs, read from its CI files. The hand-off check runs these before the commands above. */
  checks: z.array(CardCheckSchema).default([]),
  structure: z.array(z.object({ path: z.string(), note: z.string() })),
  conventions: z.array(z.string()),
  ci: z.object({ provider: z.string().optional(), workflows: z.array(z.string()) }),
  deploy: z.array(z.string()),
  remotes: z.array(z.object({ name: z.string(), url: z.string() })),
  aliases: z.array(z.string()),
  readiness: ReadinessSchema,
});
export type ProjectCard = z.infer<typeof ProjectCardSchema>;
