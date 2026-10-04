import { z } from "zod";
import { IdSchema } from "./ids.ts";

/**
 * Deadlines (SPEC 5.19): hackathons, grants, launches, client dates and renewals. Every row belongs to
 * one workspace or, with no `org`, to the whole business. A captain lane or an agent reads its own
 * workspace's rows and the business rows only.
 */

const Text = (max: number) => z.string().trim().min(1).max(max);

/** The workspace view an input asks for: the workspace's rows plus the business ones. */
export const ScopeFilterSchema = z.object({
  /** A workspace id. Its own rows and the business-wide rows are returned. */
  org: IdSchema.optional(),
  /** Only the business-wide rows. */
  businessOnly: z.boolean().optional(),
});

/** A calendar day, `2026-11-20`. */
export const IsoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-20");

// ---------------------------------------------------------------------------
// Deadlines

export const DEADLINE_KINDS = ["hackathon", "grant", "launch", "client", "renewal", "other"] as const;
export const DeadlineKindSchema = z.enum(DEADLINE_KINDS);
export type DeadlineKind = z.infer<typeof DeadlineKindSchema>;
export const DEADLINE_KIND_LABEL: Record<DeadlineKind, string> = {
  hackathon: "Hackathon",
  grant: "Grant",
  launch: "Launch",
  client: "Client",
  renewal: "Renewal",
  other: "Other",
};

export const DeadlineStatusSchema = z.enum(["open", "done", "dropped"]);
export type DeadlineStatus = z.infer<typeof DeadlineStatusSchema>;

/** `2026-11-20` (all day) or `2026-11-20T17:00`: wall-clock time in the deadline's own time zone. */
export const DueSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, "Use 2026-11-20 or 2026-11-20T17:00");

export const TimeZoneNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Use a time zone like Europe/Berlin");

/** How near a deadline is, in its own time zone. */
export const DeadlineStateSchema = z.enum(["overdue", "today", "soon", "later", "closed"]);
export type DeadlineState = z.infer<typeof DeadlineStateSchema>;

export const DEADLINE_STATE_LABEL: Record<DeadlineState, string> = {
  overdue: "Overdue",
  today: "Today",
  soon: "Soon",
  later: "Later",
  closed: "Closed",
};

export const DeadlineSchema = z.object({
  id: z.number().int().positive(),
  org: IdSchema.optional(),
  kind: DeadlineKindSchema,
  title: z.string(),
  due: DueSchema,
  tz: z.string(),
  allDay: z.boolean(),
  /** The moment it falls due, in UTC. An all-day deadline ends with its last minute. */
  dueAt: z.string(),
  /** Where it was found: a link or a note. */
  source: z.string(),
  notes: z.string(),
  /** Days before the deadline that a reminder is due, largest first. */
  leadDays: z.array(z.number().int().min(0).max(365)),
  /** The next reminder that has not passed, in UTC. */
  nextReminder: z.string().optional(),
  goal: z.string().optional(),
  finding: z.number().int().positive().optional(),
  status: DeadlineStatusSchema,
  state: DeadlineStateSchema,
  /** Whole days from today to the due day in its own zone; negative when past. */
  daysLeft: z.number().int(),
  by: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Deadline = z.infer<typeof DeadlineSchema>;

export const DeadlinesListInputSchema = ScopeFilterSchema.extend({
  kind: DeadlineKindSchema.optional(),
  /** Default: open. */
  status: z.union([DeadlineStatusSchema, z.literal("all")]).optional(),
  /** Only those due within this many days (overdue ones included). */
  withinDays: z.number().int().min(0).max(3650).optional(),
  limit: z.number().int().min(1).max(2000).default(500),
});
export type DeadlinesListInput = z.infer<typeof DeadlinesListInputSchema>;
export const DeadlinesListSchema = z.object({ deadlines: z.array(DeadlineSchema) });
export type DeadlinesList = z.infer<typeof DeadlinesListSchema>;

export const DeadlineUpsertInputSchema = z.object({
  id: z.number().int().positive().optional(),
  org: IdSchema.optional(),
  kind: DeadlineKindSchema,
  title: Text(200),
  due: DueSchema,
  /** Default: this machine's zone. */
  tz: TimeZoneNameSchema.optional(),
  source: z.string().trim().max(500).default(""),
  notes: z.string().max(4_000).default(""),
  leadDays: z.array(z.number().int().min(0).max(365)).max(8).default([14, 7, 1]),
  goal: IdSchema.optional(),
  finding: z.number().int().positive().optional(),
  status: DeadlineStatusSchema.default("open"),
});
export type DeadlineUpsertInput = z.infer<typeof DeadlineUpsertInputSchema>;
export const DeadlineIdInputSchema = z.object({ id: z.number().int().positive() });
