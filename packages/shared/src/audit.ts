import { z } from "zod";
import { TaskIdSchema } from "./tasks.ts";

/**
 * The audit log: what majhi did or was allowed to do. `decision` is allow, deny or cancelled for a
 * permission or an approval, and done or failed for something majhi carried out (a push, a merge).
 */
export const AuditDecisionSchema = z.enum(["allow", "deny", "cancelled", "done", "failed"]);
export type AuditDecision = z.infer<typeof AuditDecisionSchema>;

/**
 * Who decided or triggered it: the owner, a rule, a lead, an agent, majhi itself, or autonomous mode
 * approving a card within its limits (PRV-74).
 */
export const AuditBySchema = z.enum(["owner", "rule", "lead", "agent", "majhi", "autonomy", "captain"]);
export type AuditBy = z.infer<typeof AuditBySchema>;

export const AuditEntrySchema = z.object({
  /** Newest first: pass the last id as `before` for the next page. */
  id: z.number().int().positive(),
  task: z.string(),
  /** The agent concerned, or who ran it (`owner`) when no agent did. */
  agent: z.string(),
  kind: z.string(),
  title: z.string(),
  decision: AuditDecisionSchema,
  by: AuditBySchema,
  at: z.string(),
  /** Empty only for a row of a task that was already gone when it was written. */
  org: z.string().optional(),
  /** The target branch, the merge request link or the error. */
  detail: z.string().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** A date (`2026-10-01`) or a time (`2026-10-01T12:00:00Z`). */
const WhenSchema = z
  .string()
  .max(40)
  .refine(
    (s) => !Number.isNaN(Date.parse(s)),
    "Use a date like 2026-10-01 or a time like 2026-10-01T12:00:00Z",
  );

export const AuditListInputSchema = z.object({
  org: z.string().min(1).max(100).optional(),
  task: TaskIdSchema.optional(),
  /** Any of these kinds. */
  kinds: z.array(z.string().min(1).max(100)).max(50).optional(),
  agent: z.string().min(1).max(200).optional(),
  decision: AuditDecisionSchema.optional(),
  /** Inclusive. */
  from: WhenSchema.optional(),
  /** Inclusive. A date alone covers that whole day (UTC). */
  to: WhenSchema.optional(),
  /** Only entries older than this id: the `next` of the page before. */
  before: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type AuditListInput = z.input<typeof AuditListInputSchema>;

export const AuditListSchema = z.object({
  entries: z.array(AuditEntrySchema),
  /** Set when there are older entries: pass it as `before`. */
  next: z.number().int().positive().optional(),
  /** Everything in the log, whatever the filters, to fill the filter lists. */
  kinds: z.array(z.string()),
  agents: z.array(z.string()),
  orgs: z.array(z.string()),
});
export type AuditList = z.infer<typeof AuditListSchema>;
