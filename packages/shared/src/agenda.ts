import { z } from "zod";
import { FindingSeveritySchema } from "./findings.ts";

/**
 * The agenda and the morning brief (SPEC 5.18): one ordered list per day of what needs the owner, computed
 * in code with no model, and one short brief per day. `agenda.today` returns everything the Today page needs.
 */

/** A calendar day, `2026-11-20`. */
export const IsoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-20");

/** What an agenda item is. `decision` covers ships, questions, approvals and sign-ins; `budget` a budget hold. */
export const AGENDA_KINDS = ["incident", "budget", "decision", "finding", "draft"] as const;
export const AgendaKindSchema = z.enum(AGENDA_KINDS);
export type AgendaKind = z.infer<typeof AgendaKindSchema>;

export const AGENDA_KIND_LABEL: Record<AgendaKind, string> = {
  incident: "Incident",
  budget: "Budget",
  decision: "Decision",
  finding: "Finding",
  draft: "Draft",
};

/** Where the one action goes. Each opens a place that already exists. */
export const AgendaTargetSchema = z.discriminatedUnion("to", [
  z.object({ to: z.literal("decision"), id: z.string().min(1).max(300) }),
  z.object({ to: z.literal("finding"), id: z.number().int().positive() }),
  z.object({ to: z.literal("limits") }),
  z.object({ to: z.literal("playbooks") }),
]);
export type AgendaTarget = z.infer<typeof AgendaTargetSchema>;

/** What `e` does with an item where the owner may do it from Today. */
export const AgendaDoneSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dismiss-finding"), id: z.number().int().positive() }),
]);
export type AgendaDone = z.infer<typeof AgendaDoneSchema>;

export const AgendaItemSchema = z.object({
  /** Stable for the same thing: `decision:<id>`, `finding:12`. */
  id: z.string().min(1).max(320),
  kind: AgendaKindSchema,
  /** The workspace id; absent for the whole business. */
  org: z.string().optional(),
  orgName: z.string().optional(),
  title: z.string().min(1).max(300),
  /** Why it is here now, in a few words ("waiting 3 h", "due in 2 days", "high severity"). */
  why: z.string().max(200),
  /** The one action's button label ("Ship", "Open", "Review"). */
  action: z.string().max(40),
  target: AgendaTargetSchema,
  /** The owner's minutes this is estimated to take. */
  minutes: z.number().int().min(1).max(120),
  /** Ordering weight, higher first. Shown nowhere; kept so a test can read it. */
  weight: z.number(),
  /** The moment it matters (due, arrived), for ties and for the "age". */
  at: z.string().optional(),
  /** Always planned for today, whatever the review budget says: an incident. */
  must: z.boolean(),
  done: AgendaDoneSchema.optional(),
});
export type AgendaItem = z.infer<typeof AgendaItemSchema>;

export const MorningBriefSourceSchema = z.enum(["model", "template"]);
export type MorningBriefSource = z.infer<typeof MorningBriefSourceSchema>;

/** The facts the brief is built from. Code gathers them; the model, when there is one, only words them. */
export const BriefFactsSchema = z.object({
  day: IsoDaySchema,
  /** The span the overnight numbers cover (UTC). */
  from: z.string(),
  to: z.string(),
  shipped: z.number().int().min(0),
  shippedTitles: z.array(z.string()).max(3),
  merged: z.number().int().min(0),
  failed: z.number().int().min(0),
  spent: z.number().min(0),
  /** The day budget in dollars, when one is set. */
  budget: z.number().min(0).optional(),
  findingsNew: z.number().int().min(0),
  findingsFixed: z.number().int().min(0),
  /** What the captain did by itself, in counts: decisions it answered and chores it ran. */
  captainDecided: z.number().int().min(0),
  captainUpkeep: z.number().int().min(0),
  /** The scorecard's one line when the scorecard exists. */
  scorecard: z.string().max(200).optional(),
  needs: z.object({
    count: z.number().int().min(0),
    minutes: z.number().int().min(0),
    top: z.array(z.string()).max(3),
  }),
  next: z.array(z.string()).max(3),
  /** Nothing waits for the owner. */
  empty: z.boolean(),
});
export type BriefFacts = z.infer<typeof BriefFactsSchema>;

export const BRIEF_MAX_LINES = 6;
export const BRIEF_LINE_MAX = 180;

export const BriefSchema = z.object({
  day: IsoDaySchema,
  /** When it was made (ISO). */
  at: z.string(),
  lines: z.array(z.string().min(1).max(BRIEF_LINE_MAX)).min(1).max(BRIEF_MAX_LINES),
  source: MorningBriefSourceSchema,
  facts: BriefFactsSchema,
  dismissed: z.boolean(),
});
export type Brief = z.infer<typeof BriefSchema>;

export const AgendaWatchTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  org: z.string().optional(),
  orgName: z.string().optional(),
  since: z.string().optional(),
});

export const AgendaPlanGoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  org: z.string(),
  orgName: z.string().optional(),
  target: z.string().optional(),
  due: z.string().optional(),
  status: z.string(),
  /** Open findings tied to it. */
  linked: z.number().int().min(0),
});

export const AgendaTodaySchema = z.object({
  /** The owner's local day, `2026-10-04`, and the zone it is in. */
  day: IsoDaySchema,
  tz: z.string(),
  at: z.string(),
  /** The owner's review budget in minutes (default 45) and what today's list takes. */
  budgetMinutes: z.number().int().min(5).max(600),
  usedMinutes: z.number().int().min(0),
  /** The list does not fit: only `must` items went past the budget. */
  over: z.boolean(),
  today: z.array(AgendaItemSchema),
  later: z.array(AgendaItemSchema),
  laterMinutes: z.number().int().min(0),
  brief: BriefSchema.optional(),
  /** The brief is being made right now; the page asks again when the server says it changed. */
  briefPending: z.boolean(),
  /** The brief hour (24 h clock in `tz`) and whether today's has passed. */
  briefAt: z.string(),
  watch: z.object({
    running: z.array(AgendaWatchTaskSchema),
    incidents: z.array(
      z.object({
        id: z.number().int().positive(),
        title: z.string(),
        severity: FindingSeveritySchema,
        org: z.string().optional(),
        orgName: z.string().optional(),
        at: z.string(),
      }),
    ),
    /** Today's spend against the day budget, for the strip. */
    spent: z.number().min(0),
    budget: z.number().min(0).optional(),
  }),
  plan: z.object({
    goals: z.array(AgendaPlanGoalSchema),
    /** What the captain will do next, as the queue says. Shown when nothing needs the owner. */
    captainNext: z.array(z.string()).max(5),
  }),
});
export type AgendaToday = z.infer<typeof AgendaTodaySchema>;

export const AgendaTodayInputSchema = z.object({
  /** Only this workspace (and the business's own items). */
  org: z.string().min(1).max(63).optional(),
});
export type AgendaTodayInput = z.infer<typeof AgendaTodayInputSchema>;

export const AGENDA_BUDGET_DEFAULT = 45;

export const AgendaConfigureInputSchema = z.object({
  /** The owner's review time per day, in minutes. */
  budgetMinutes: z.number().int().min(5).max(600),
});
export type AgendaConfigureInput = z.infer<typeof AgendaConfigureInputSchema>;

export const AgendaBriefInputSchema = z.object({
  /** Make today's brief now when it is missing. */
  force: z.boolean().optional(),
});

export const AgendaDismissInputSchema = z.object({ day: IsoDaySchema });
