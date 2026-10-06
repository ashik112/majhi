import { z } from "zod";
import { HandoffStepIdSchema } from "./handoff.ts";
import { IdSchema, TaskIdSchema } from "./ids.ts";
import { CiStateSchema, MrStateSchema } from "./mr-state.ts";
import { OriginViewSchema } from "./task-origin.ts";
import { WikiRoleSchema } from "./wiki.ts";

/**
 * The read models of a task's trail and areas. Neither is stored: the trail is assembled from the
 * links, merge requests, hand-off check and pending ship that exist, the areas from the files the
 * task changed and the wiki's components. `buildTrail` (trail-build.ts) is the one assembler.
 */

/**
 * How a step reads at a glance. `needs`: the owner has to act. `paused`: held, and majhi or time
 * lifts it. `working`: moving now. `idle`: nothing is moving it yet. `done`: finished.
 */
export const TrailToneSchema = z.enum(["done", "working", "needs", "paused", "idle"]);
export type TrailTone = z.infer<typeof TrailToneSchema>;

const tone = { tone: TrailToneSchema };

/**
 * One step of a task's trail, in the order a task produces them. Phases B and C add what the `deploy`
 * and `reply` steps carry; nothing produces them yet.
 */
export const TrailStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("children"),
    ...tone,
    total: z.number().int().positive(),
    done: z.number().int().nonnegative(),
    /** Only in the single read (`tasks.detail`): each child with its own tone. */
    items: z.array(z.object({ id: TaskIdSchema, title: z.string(), tone: TrailToneSchema })).optional(),
  }),
  z.object({
    kind: z.literal("check"),
    ...tone,
    /** The hand-off check of the task's head: `green` or `red`, or still `running` or `queued`. */
    result: z.enum(["green", "red", "running", "queued"]),
    /** The step a red check failed on. */
    failedStep: HandoffStepIdSchema.optional(),
  }),
  z.object({
    kind: z.literal("merge-request"),
    ...tone,
    mrs: z
      .array(
        z.object({
          project: IdSchema,
          number: z.number().int().positive(),
          url: z.string(),
          state: MrStateSchema,
          ci: CiStateSchema,
        }),
      )
      .min(1),
  }),
  z.object({
    kind: z.literal("local-merge"),
    ...tone,
    /** `pending`: majhi merges once the lead has resolved conflicts. `merged`: landed in the base branch. */
    stage: z.enum(["pending", "merged"]),
    projects: z.array(IdSchema).min(1),
  }),
  z.object({ kind: z.literal("deploy"), ...tone, env: z.string().min(1).max(60) }),
  z.object({ kind: z.literal("reply"), ...tone }),
]);
export type TrailStep = z.infer<typeof TrailStepSchema>;
export type TrailKind = TrailStep["kind"];

export const TrailSchema = z.array(TrailStepSchema);
export type Trail = z.infer<typeof TrailSchema>;

/** A wiki component some of the task's changed files fall in. */
export const AreaSchema = z.object({
  project: IdSchema,
  /** The component's name in the wiki. */
  component: z.string().min(1),
  /** Its folder in the project. */
  folder: z.string(),
  role: WikiRoleSchema,
  /** How many of the task's changed files fall in it. */
  files: z.number().int().positive(),
});
export type Area = z.infer<typeof AreaSchema>;

/**
 * The parts of the system a task touches. Empty when the workspace has no wiki, the wiki knows no
 * components for the task's projects, or nothing changed yet. `unmapped` counts changed files that
 * fall in no component.
 */
export const TaskAreasSchema = z.object({
  areas: z.array(AreaSchema),
  unmapped: z.number().int().nonnegative(),
});
export type TaskAreas = z.infer<typeof TaskAreasSchema>;

/** The single read of a task: where it came from, what it touches, and its whole trail. */
export const TaskDetailSchema = z.object({
  task: TaskIdSchema,
  origin: OriginViewSchema.optional(),
  areas: TaskAreasSchema,
  /** Like the summary's trail, plus the hand-off check, and each child listed. */
  trail: TrailSchema,
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
