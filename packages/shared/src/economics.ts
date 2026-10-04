import { z } from "zod";
import { DeadlineSchema } from "./business.ts";
import { IdSchema } from "./ids.ts";
import { DraftSchema } from "./playbooks.ts";

/**
 * Client economics and the growth playbooks' small views (SPEC 5.18, captain v2 step 11). Economics
 * reads what already happened: shipped work, agent time, spend, the owner's time, and the owner's own
 * rates. A number that needs a rate the owner did not enter is absent, never guessed.
 */

export const ECONOMICS_RANGES = ["week", "month"] as const;
export const EconomicsRangeSchema = z.enum(ECONOMICS_RANGES);
export type EconomicsRange = z.infer<typeof EconomicsRangeSchema>;

/** A measure in this period and in the one before it, over the same stretch. */
export const PairSchema = z.object({ now: z.number(), before: z.number() });
export type Pair = z.infer<typeof PairSchema>;

export const ECONOMICS_FLAGS = ["spend-outpaces-work", "quiet", "near-budget"] as const;
export const EconomicsFlagKindSchema = z.enum(ECONOMICS_FLAGS);
export type EconomicsFlagKind = z.infer<typeof EconomicsFlagKindSchema>;

export const EconomicsFlagSchema = z.object({
  kind: EconomicsFlagKindSchema,
  /** One sentence the owner can read cold. */
  text: z.string(),
});
export type EconomicsFlag = z.infer<typeof EconomicsFlagSchema>;

export const EconomicsRowSchema = z.object({
  org: IdSchema,
  /** Tasks that shipped (a push, a merge request or a merge) in the period. */
  shipped: PairSchema,
  /** Minutes agents worked on the workspace's tasks. */
  agentMinutes: PairSchema,
  spentUsd: PairSchema,
  /** The owner's time in reviews and decisions, estimated from what they did (see `estimate`). */
  ownerMinutes: PairSchema,
  retainerUsd: z.number().optional(),
  hourlyUsd: z.number().optional(),
  /** What the client pays for the period: the retainer, prorated for a week. Absent without a retainer. */
  valueUsd: z.number().optional(),
  /** The owner's minutes at their hourly rate. Absent without a rate. */
  ownerCostUsd: z.number().optional(),
  /** Value less spend, and less the owner's time when there is a rate. Absent without a retainer. */
  marginUsd: z.number().optional(),
  /** When the last task shipped, any time. */
  lastShippedAt: z.string().optional(),
  flags: z.array(EconomicsFlagSchema),
});
export type EconomicsRow = z.infer<typeof EconomicsRowSchema>;

export const EconomicsSchema = z.object({
  range: EconomicsRangeSchema,
  from: z.string(),
  to: z.string(),
  previousFrom: z.string(),
  previousTo: z.string(),
  /** "Last 7 days" or "June so far". */
  label: z.string(),
  /** How the owner's minutes are estimated, in a sentence. */
  estimate: z.string(),
  rows: z.array(EconomicsRowSchema),
});
export type Economics = z.infer<typeof EconomicsSchema>;

export const EconomicsGetInputSchema = z.object({
  range: EconomicsRangeSchema.default("week"),
  org: IdSchema.optional(),
});

/** The shape of a percent change: absent when there was nothing before. */
export function changePercent(p: Pair): number | undefined {
  if (p.before <= 0) return undefined;
  return Math.round(((p.now - p.before) / p.before) * 100);
}

/** "+25%", "-10%", "same", or "new" when there was nothing before and there is something now. */
export function changeWord(p: Pair): string {
  const c = changePercent(p);
  if (c === undefined) return p.now > 0 ? "new" : "";
  if (c === 0) return "same";
  return `${c > 0 ? "+" : ""}${c}%`;
}

// ---------------------------------------------------------------------------
// Opportunities and feeds

/** A finding that carries a deadline holds one evidence line `deadline:YYYY-MM-DD`. */
export const DEADLINE_EVIDENCE = "deadline:";

/** The deadline day a finding carries, or undefined. */
export function findingDeadline(evidence: readonly string[]): string | undefined {
  for (const e of evidence) {
    const m = /^deadline:(\d{4}-\d{2}-\d{2})$/.exec(e);
    if (m?.[1] !== undefined) return m[1];
  }
  return undefined;
}

/** The effort an opportunity states in its detail ("Effort: medium."), or undefined. */
export function opportunityEffort(detail: string): "small" | "medium" | "large" | undefined {
  const m = /^effort:\s*(small|medium|large)\b/im.exec(detail);
  return m?.[1] === undefined ? undefined : (m[1].toLowerCase() as "small" | "medium" | "large");
}

export const FindingProposalInputSchema = z.object({ id: z.number().int().positive() });
export const FindingProposalResultSchema = z.object({
  draft: DraftSchema,
  text: z.string(),
});
export const FindingDeadlineInputSchema = z.object({ id: z.number().int().positive() });
export const FindingDeadlineResultSchema = z.object({ deadline: DeadlineSchema });
