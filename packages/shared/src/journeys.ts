import { z } from "zod";
import { IdSchema } from "./accounts.ts";

/**
 * Journeys on the project map (SPEC 5.21): one thing that happens, step by step, over the lines the map
 * already has ("a customer orders a part"). The owner names one by picking lines in order; majhi proposes
 * examples from the lines it found, and an example is kept only when the owner keeps it.
 */

export const JOURNEY_LIMITS = { steps: 12, name: 60, label: 60 } as const;

const NodeRef = z.string().trim().min(1).max(120);

/** A step as stored: which two boxes it goes between, what it is called, and the map line it follows. */
export const JourneyStepSchema = z.object({
  from: NodeRef,
  to: NodeRef,
  label: z.string().trim().min(1).max(JOURNEY_LIMITS.label),
  /** The id of the map line. Absent, or a line that is gone from the map: the step needs a check. */
  edge: z.string().trim().min(1).max(300).optional(),
});
export type JourneyStep = z.infer<typeof JourneyStepSchema>;

export const JourneySchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(JOURNEY_LIMITS.name),
  steps: z.array(JourneyStepSchema).min(1).max(JOURNEY_LIMITS.steps),
  createdAt: z.string(),
});
export type Journey = z.infer<typeof JourneySchema>;

/** A step as shown: `check` is true when no map line stands behind it (none was named, or the line was removed) or the line is itself unchecked. */
export const JourneyStepViewSchema = JourneyStepSchema.extend({ check: z.boolean() });
export type JourneyStepView = z.infer<typeof JourneyStepViewSchema>;

/** `kept`: the owner's. `example`: majhi's guess from the lines it found, until the owner keeps it. */
export const JourneyViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["kept", "example"]),
  steps: z.array(JourneyStepViewSchema).max(JOURNEY_LIMITS.steps),
});
export type JourneyView = z.infer<typeof JourneyViewSchema>;

export const JourneyInputSchema = z.object({
  org: IdSchema,
  /** Absent: a new journey. Present: replace that journey's name and steps. */
  id: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(JOURNEY_LIMITS.name),
  steps: z.array(JourneyStepSchema).min(1).max(JOURNEY_LIMITS.steps),
});
export const JourneyRemoveInputSchema = z.object({ org: IdSchema, id: z.string().trim().min(1).max(80) });
