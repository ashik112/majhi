import { z } from "zod";
import { askedOptions, DecisionUseSchema, optionKey, type Question } from "./decisions.ts";

/**
 * How majhi learns whether a decision provider is right (SPEC 5.12): labels from outcomes and from
 * the owner, evals over them, and per-slot calibration. A slot is one question of one use, like
 * `task-size` or `mention-wake`.
 */

// Labels --------------------------------------------------------------------

/**
 * Where a label came from. `outcome`: what happened afterwards (the diff size of a finished task,
 * whether a woken agent acted, the owner keeping or dropping a fact). `owner`: the owner named the
 * right answer ("Wrong?"). `teacher`: a stronger provider answered where Laya was unsure.
 */
export const LabelSourceSchema = z.enum(["outcome", "owner", "teacher"]);
export type LabelSource = z.infer<typeof LabelSourceSchema>;

/** What a decision is linked to until its outcome is known. */
export const LinkKindSchema = z.enum([
  "task",
  "wake",
  "memory",
  "tracker",
  "finding",
  "own-work",
  "turn",
  "typed",
  "client-chat",
]);
export type LinkKind = z.infer<typeof LinkKindSchema>;

/** The right answer to one question of one decision, and how we know. */
export const DecisionLabelSchema = z.object({
  decisionId: z.string().min(1).max(40),
  use: DecisionUseSchema,
  /** The question's key in the decision. */
  question: z.string().min(1).max(60),
  /** The right option's key, `true` or `false` for a yes/no, or the score as text. */
  label: z.string().trim().min(1).max(100),
  source: LabelSourceSchema,
  /** Why, in plain words: "diff of 3 files and 41 lines, 12 turns". */
  note: z.string().max(300).optional(),
  at: z.string(),
});
export type DecisionLabel = z.infer<typeof DecisionLabelSchema>;

/** What a question can be answered with, as label strings: a choice's options, `true` and `false`, or the scale. */
export function answerChoices(q: Question): string[] {
  if (q.type === "choice") return askedOptions(q).map(optionKey);
  if (q.type === "noul") return ["true", "false"];
  return Array.from({ length: Math.max(0, q.max - q.min + 1) }, (_, i) => String(q.min + i));
}

/** The owner's "Wrong?": the right answer to one question of a decision. */
export const LabelInputSchema = z.object({
  id: z.string().min(1).max(40),
  /** Omit for a decision with one question. */
  question: z.string().min(1).max(60).optional(),
  right: z.string().trim().min(1).max(100),
  note: z.string().trim().max(300).optional(),
});
export type LabelInput = z.infer<typeof LabelInputSchema>;

// Evals and calibration ------------------------------------------------------

/**
 * `live`: the use passed an eval on its labels, so an answer that clears its calibrated threshold
 * counts. `shadow`: Laya answers and the answer is logged and compared with what happened, but
 * nothing acts on it and the caller falls back to its safe default.
 */
export const SlotModeSchema = z.enum(["shadow", "live"]);
export type SlotMode = z.infer<typeof SlotModeSchema>;

export const ClassMetricSchema = z.object({
  label: z.string(),
  /** Labeled items of this class. */
  support: z.number().int().nonnegative(),
  /** Share of this class's items answered with it. Null with no support. */
  recall: z.number().min(0).max(1).nullable(),
  /** Share of answers of this class that were right. Null when it was never answered. */
  precision: z.number().min(0).max(1).nullable(),
});
export type ClassMetric = z.infer<typeof ClassMetricSchema>;

export const EvalMetricsSchema = z.object({
  /** Items that got an answer. */
  n: z.number().int().nonnegative(),
  /** Items the provider failed on. */
  failed: z.number().int().nonnegative(),
  accuracy: z.number().min(0).max(1).nullable(),
  /** Accuracy of always answering the commonest label: what an answer must beat. */
  majorityBaseline: z.number().min(0).max(1).nullable(),
  perClass: z.array(ClassMetricSchema),
  /** Of the items that clear the gate, how many were right. Null when none clear it. */
  precision: z.number().min(0).max(1).nullable(),
  /** Share of items that clear the gate. */
  coverage: z.number().min(0).max(1),
  /** Expected calibration error of the answer's confidence, 10 bins. Null with no items. */
  ece: z.number().min(0).max(1).nullable(),
  /** Share of choices that name the same option when asked in two option orders. Null when none was asked twice. */
  orderConsistency: z.number().min(0).max(1).nullable(),
  latencyP50Ms: z.number().nonnegative().nullable(),
  latencyP90Ms: z.number().nonnegative().nullable(),
  /** Money per 1,000 decisions. Zero for Laya. */
  costPer1000Usd: z.number().nonnegative(),
});
export type EvalMetrics = z.infer<typeof EvalMetricsSchema>;

/** The fitted correction for one slot: a temperature on the probabilities and a bar on the result. */
export const CalibrationSchema = z.object({
  slot: z.string(),
  mode: SlotModeSchema,
  /** Probabilities are raised to 1/temperature and renormalized. 1 leaves them as they are. */
  temperature: z.number().positive(),
  /** An answer counts when its calibrated confidence is at least this. */
  threshold: z.number().min(0).max(1),
  /** The precision the threshold was chosen for. */
  target: z.number().min(0).max(1),
  /** What the threshold got on the held-out half. */
  heldOutPrecision: z.number().min(0).max(1).nullable(),
  heldOutCoverage: z.number().min(0).max(1),
  /** Labels the fit used. */
  labels: z.number().int().nonnegative(),
  /** The model that answered during the fit; a new one needs a new eval. */
  version: z.string(),
  fittedAt: z.string(),
  /** Why it is live or in shadow, in plain words. */
  reason: z.string(),
});
export type Calibration = z.infer<typeof CalibrationSchema>;

export const EvalSetSchema = z.enum(["labels", "fixtures"]);
export type EvalSet = z.infer<typeof EvalSetSchema>;

/** One run of one slot over one set. */
export const EvalReportSchema = z.object({
  id: z.number().int().positive(),
  slot: z.string(),
  title: z.string(),
  set: EvalSetSchema,
  at: z.string(),
  provider: z.string(),
  version: z.string(),
  /** At the gate as it stands (the slot's calibration if it has one, else the base bar). */
  metrics: EvalMetricsSchema,
  /** On the held-out half after the fit; absent for the fixtures and when too few labels exist. */
  heldOut: EvalMetricsSchema.optional(),
  calibration: CalibrationSchema.optional(),
});
export type EvalReport = z.infer<typeof EvalReportSchema>;

export const EvalInputSchema = z.object({
  /** A slot id like `task-size`, or `all`. */
  use: z.string().min(1).max(80),
});

/** What the Hub shows per slot: its mode, how many labels it has and its last runs. */
export const SlotStatusSchema = z.object({
  slot: z.string(),
  title: z.string(),
  use: DecisionUseSchema,
  mode: SlotModeSchema,
  labels: z.number().int().nonnegative(),
  /** Labels needed before a fit is tried. */
  labelsNeeded: z.number().int().positive(),
  target: z.number().min(0).max(1),
  calibration: CalibrationSchema.optional(),
  labeled: EvalReportSchema.optional(),
  fixtures: EvalReportSchema.optional(),
  /** True when this slot has a built-in fixture set. */
  hasFixtures: z.boolean(),
  /** The run before the last one on the same set, so the Hub can show a drift. */
  previous: z
    .object({
      at: z.string(),
      accuracy: z.number().min(0).max(1).nullable(),
      precision: z.number().min(0).max(1).nullable(),
    })
    .optional(),
  /** Why the slot got worse since the run before, or is live under its target: the weekly eval files a finding for it. */
  regressed: z.string().optional(),
});
export type SlotStatus = z.infer<typeof SlotStatusSchema>;
