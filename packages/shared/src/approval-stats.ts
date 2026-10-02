import { z } from "zod";

/** What happened: approval cards per command over the last days (`policy.cardStats`). */

export const CardCountsSchema = z.object({
  /** Every card posted, whatever came of it. */
  shown: z.number().int().nonnegative(),
  /** The owner clicked Approve and it ran (or ran and was undone later). */
  approved: z.number().int().nonnegative(),
  /** It ran without a click: the policy or a saved rule let it. */
  ranAlone: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Still waiting for the owner. */
  waiting: z.number().int().nonnegative(),
});
export type CardCounts = z.infer<typeof CardCountsSchema>;

export const ApprovalStatsSchema = z.object({
  days: z.number().int().positive(),
  /** The first moment counted, ISO. */
  since: z.string(),
  commands: z.array(CardCountsSchema.extend({ command: z.string() })),
});
export type ApprovalStats = z.infer<typeof ApprovalStatsSchema>;

export const EMPTY_COUNTS: CardCounts = {
  shown: 0,
  approved: 0,
  ranAlone: 0,
  rejected: 0,
  failed: 0,
  waiting: 0,
};

/** Adds one card to the counts. `alone` is true when it ran with no owner click. */
export function countCard(
  counts: CardCounts,
  state: "pending" | "applied" | "rejected" | "failed" | "undone",
  alone: boolean,
  n = 1,
): CardCounts {
  const next = { ...counts, shown: counts.shown + n };
  switch (state) {
    case "pending":
      return { ...next, waiting: next.waiting + n };
    case "rejected":
      return { ...next, rejected: next.rejected + n };
    case "failed":
      return { ...next, failed: next.failed + n };
    case "applied":
    case "undone":
      return alone ? { ...next, ranAlone: next.ranAlone + n } : { ...next, approved: next.approved + n };
  }
}

export function sumCounts(list: readonly CardCounts[]): CardCounts {
  return list.reduce<CardCounts>(
    (sum, c) => ({
      shown: sum.shown + c.shown,
      approved: sum.approved + c.approved,
      ranAlone: sum.ranAlone + c.ranAlone,
      rejected: sum.rejected + c.rejected,
      failed: sum.failed + c.failed,
      waiting: sum.waiting + c.waiting,
    }),
    EMPTY_COUNTS,
  );
}
