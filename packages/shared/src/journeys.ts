import { z } from "zod";
import { IdSchema } from "./accounts.ts";
import { InsideTriggerSchema } from "./inside.ts";

/**
 * Journeys on the project map (SPEC 5.21): one thing that happens, step by step, over the lines the map
 * already has ("a customer orders a part"), or inside one project ("a nightly job builds a brief"). The
 * owner names one by picking lines in order; majhi proposes examples from what it found, and an example
 * is kept only when the owner keeps it.
 */

export const JOURNEY_LIMITS = { steps: 12, name: 60, label: 60 } as const;

const NodeRef = z.string().trim().min(1).max(160);

/** What a step's two ends are: a project of the map, or (inside one project) something in its code. */
export const JOURNEY_PART_KINDS = ["project", "entry", "function", "outside", "database"] as const;
export const JourneyPartKindSchema = z.enum(JOURNEY_PART_KINDS);
export type JourneyPartKind = z.infer<typeof JourneyPartKindSchema>;

/** The line of code a step stands on, for steps inside a project (a step between projects has a map line). */
export const JourneyProofSchema = z.object({
  file: z.string().min(1).max(400),
  line: z.number().int().positive(),
  text: z.string().max(240).default(""),
});

/** A step as stored: which two boxes it goes between, what it is called, and the map line it follows. */
export const JourneyStepSchema = z.object({
  from: NodeRef,
  to: NodeRef,
  label: z.string().trim().min(1).max(JOURNEY_LIMITS.label),
  /** The id of the map line. Absent, or a line that is gone from the map: the step needs a check. */
  edge: z.string().trim().min(1).max(300).optional(),
  /** Inside a project: what the two ends are and where the code says so. */
  fromKind: JourneyPartKindSchema.optional(),
  toKind: JourneyPartKindSchema.optional(),
  proof: JourneyProofSchema.optional(),
});
export type JourneyStep = z.infer<typeof JourneyStepSchema>;

/** A journey that stays inside one project, started by one of its entry points. */
export const JourneyInnerSchema = z.object({
  project: z.string().trim().min(1).max(120),
  entry: z.string().trim().min(1).max(40),
});
export type JourneyInner = z.infer<typeof JourneyInnerSchema>;

export const JourneySchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(JOURNEY_LIMITS.name),
  steps: z.array(JourneyStepSchema).min(1).max(JOURNEY_LIMITS.steps),
  trigger: InsideTriggerSchema.optional(),
  inner: JourneyInnerSchema.optional(),
  createdAt: z.string(),
});
export type Journey = z.infer<typeof JourneySchema>;

/** A step as shown: `check` is true when no map line stands behind it (none was named, or the line was removed) or the line is itself unchecked. */
export const JourneyStepViewSchema = JourneyStepSchema.extend({ check: z.boolean() });
export type JourneyStepView = z.infer<typeof JourneyStepViewSchema>;

/** `kept`: the owner's. `example`: majhi's guess from what it found, until the owner keeps it. */
export const JourneyViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["kept", "example"]),
  /** What starts it. */
  trigger: InsideTriggerSchema.default("HTTP"),
  /** The project it starts in. */
  start: z.string().default(""),
  /** Every project of the map it touches, in the order it reaches them. */
  touches: z.array(z.string()).default([]),
  inner: JourneyInnerSchema.optional(),
  steps: z.array(JourneyStepViewSchema).max(JOURNEY_LIMITS.steps),
});
export type JourneyView = z.infer<typeof JourneyViewSchema>;

export const JourneyInputSchema = z.object({
  org: IdSchema,
  /** Absent: a new journey. Present: replace that journey's name and steps. */
  id: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(JOURNEY_LIMITS.name),
  steps: z.array(JourneyStepSchema).min(1).max(JOURNEY_LIMITS.steps),
  trigger: InsideTriggerSchema.optional(),
  inner: JourneyInnerSchema.optional(),
});
export const JourneyRemoveInputSchema = z.object({ org: IdSchema, id: z.string().trim().min(1).max(80) });
