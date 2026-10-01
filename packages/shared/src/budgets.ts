import { z } from "zod";
import { BudgetSchema } from "./settings.ts";

/** Weekly budgets (SPEC 5.17, PRV-40): what `budgets.status` returns. */

export const BudgetScopeSchema = z.enum(["org", "account"]);
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

/** The alert thresholds, in percent of a budget. */
export const BUDGET_THRESHOLDS = [80, 100] as const;
export const BudgetThresholdSchema = z.union([z.literal(80), z.literal(100)]);
export type BudgetThreshold = z.infer<typeof BudgetThresholdSchema>;

export const BudgetAlertSchema = z.object({
  threshold: BudgetThresholdSchema,
  /** When it fired, as a UTC ISO time. */
  at: z.string(),
});
export type BudgetAlert = z.infer<typeof BudgetAlertSchema>;

export const BudgetRowSchema = z.object({
  scope: BudgetScopeSchema,
  id: z.string(),
  budget: BudgetSchema,
  /** This week's spend: tokens are input + output + cache write. */
  used: z.object({ tokens: z.number(), cost: z.number() }),
  /** Share of the budget used, 0 and up (over 100 when exceeded). With tokens and cost, the larger. */
  percent: z.number(),
  /** Which number `percent` follows. */
  measure: z.enum(["tokens", "cost"]),
  /** The week's first day (Monday), `YYYY-MM-DD`. */
  weekStart: z.string(),
  /** When the week ends and the budget starts over, as a UTC ISO time. */
  resetsAt: z.string(),
  /** Thresholds fired this week and still standing. */
  alerts: z.array(BudgetAlertSchema),
  /** The 100% alert stands: runs in this scope wait (reason `limit`) until the budget is raised, the task is resumed, or the week resets. */
  paused: z.boolean(),
});
export type BudgetRow = z.infer<typeof BudgetRowSchema>;

export const BudgetStatusSchema = z.object({
  tz: z.string(),
  rows: z.array(BudgetRowSchema),
});
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;
