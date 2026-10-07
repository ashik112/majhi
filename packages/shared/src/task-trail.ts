import { z } from "zod";
import { DeployStepStateSchema } from "./deploy.ts";
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
 * One step of a task's trail, in the order a task produces them. The `reply` step is for the phase that
 * tells the client; nothing produces it yet.
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
  /**
   * A step of shipping the rules leave to the owner: the task waits for them to do it. Only in the
   * single read (`tasks.detail`), since it is read from the ship decision for the task's diff now.
   */
  z.object({ kind: z.literal("ship"), ...tone, step: z.enum(["merge", "push"]) }),
  /** One target of a project the task changed: its state is the deploy record's, or what the ship rules say happens next. */
  z.object({
    kind: z.literal("deploy"),
    ...tone,
    env: z.string().min(1).max(60),
    project: IdSchema,
    state: DeployStepStateSchema,
    commit: z.string().optional(),
    /** The run's page, once the provider started one. */
    run: z.string().optional(),
    /** What blocks it or why it failed, in a sentence. */
    why: z.string().optional(),
  }),
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

/** Who does one step of shipping a task. */
export const ShipWhoSchema = z.enum(["captain", "owner"]);

/**
 * Who does each step of shipping a task in review or with a merge request open, read now from the
 * workspace's rows and ship rules: nothing here is stored.
 */
export const ShipViewSchema = z.object({
  merge: ShipWhoSchema,
  push: ShipWhoSchema,
  deployStaging: ShipWhoSchema,
  deployProduction: ShipWhoSchema,
  tell: ShipWhoSchema,
  /** `merge-request`: the project works through merge requests, so the work lands by one. */
  way: z.enum(["local", "merge-request"]),
  /** What the rule that decided covers ("A bug up to 200 lines"). Absent when the rows decided. */
  rule: z.string().optional(),
});
export type ShipView = z.infer<typeof ShipViewSchema>;

/** The single read of a task: where it came from, what it touches, and its whole trail. */
export const TaskDetailSchema = z.object({
  task: TaskIdSchema,
  origin: OriginViewSchema.optional(),
  areas: TaskAreasSchema,
  /** Like the summary's trail, plus the hand-off check, each child listed, and the step the owner is waited for. */
  trail: TrailSchema,
  /** Who ships it, for a task in review or with a merge request open. */
  ship: ShipViewSchema.optional(),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
