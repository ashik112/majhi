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
export const LinkKindSchema = z.enum(["task", "wake", "memory", "tracker"]);
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
