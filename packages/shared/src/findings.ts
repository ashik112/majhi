import { z } from "zod";
import { IdSchema } from "./ids.ts";
import { TaskIdSchema } from "./tasks.ts";

/**
 * Findings (SPEC 5.18, "Findings"): one deduplicated store for everything the captain's playbooks
 * notice. A finding becomes a proposed task or a decision, or is dismissed with a reason.
 */

/** The registry of finding sources. A playbook pack adds its source here; the store keeps a short string. */
export const FINDING_SOURCES = [
  "follow-up",
  "security",
  "dependency",
  "ci",
  "log",
  "ui",
  "radar",
  "opportunity",
  "setup",
  "incident",
  "competitor",
  "grant",
  "launch",
  "deal",
  "social",
  "inbox",
  "analysis",
  "legal",
  "other",
] as const;
export const FindingSourceSchema = z.enum(FINDING_SOURCES);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

export const FINDING_SOURCE_LABEL: Record<FindingSource, string> = {
  "follow-up": "Follow-up",
  security: "Security",
  dependency: "Dependency",
  ci: "CI",
  log: "Logs",
  ui: "UI",
  radar: "Radar",
  opportunity: "Opportunity",
  setup: "Setup",
  incident: "Incident",
  competitor: "Competitor",
  grant: "Grant",
  launch: "Launch",
  deal: "Deal",
  social: "Social",
  inbox: "Inbox",
  analysis: "Analysis",
  legal: "Legal",
  other: "Other",
};

export const FindingSeveritySchema = z.enum(["info", "low", "medium", "high"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/**
 * `open`: noticed, nobody acted. `proposed`: became a task in the inbox that has not started.
 * `task`: a task for it is going or was started by the owner. `decision`: handed to the owner as a
 * decision. `dismissed`: not worth doing, with a reason. `fixed`: done.
 */
export const FindingStatusSchema = z.enum(["open", "proposed", "task", "decision", "dismissed", "fixed"]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  open: "Open",
  proposed: "Proposed",
  task: "Task",
  decision: "Decision",
  dismissed: "Dismissed",
  fixed: "Fixed",
};

/** The moves a status may make. A re-report of a fixed finding reopens it; a dismissed one stays dismissed. */
export const FINDING_TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
  open: ["proposed", "task", "decision", "dismissed", "fixed"],
  proposed: ["open", "task", "dismissed", "fixed"],
  task: ["open", "decision", "dismissed", "fixed"],
  decision: ["open", "task", "dismissed", "fixed"],
  dismissed: ["open"],
  fixed: ["open"],
};

export function canMoveFinding(from: FindingStatus, to: FindingStatus): boolean {
  return from === to || FINDING_TRANSITIONS[from].includes(to);
}

/** Findings that still ask for someone's attention. */
export const FINDING_LIVE: readonly FindingStatus[] = ["open", "proposed", "task", "decision"];

/**
 * Laya's read of a new finding (SPEC 5.12, "Finding triage"): is it likely real and worth doing, or noise
 * (a hit in a test fixture or sample config, an advisory in a dev-only path, an item irrelevant to the
 * project). A suggestion for the captain and the owner; it dismisses a finding by itself only when its
 * slot is calibrated and live, the finding is info or low, and the answer is sure.
 */
export const FindingTriageSchema = z.object({
  action: z.enum(["keep", "dismiss"]),
  /** Why, in a line: "a hit in a test or sample file". Becomes the dismissal reason when it is applied. */
  reason: z.string().max(300),
  confidence: z.number().min(0).max(1),
  /** `laya`: the model said it. `rules`: a plain pattern did (a suggestion only, it never dismisses). */
  by: z.enum(["laya", "rules"]),
  /** The slot is not live yet: the suggestion is shown and logged, and acts on nothing. */
  shadow: z.boolean(),
  /** The triage dismissed the finding (live, calibrated, info or low). The owner can reopen it. */
  applied: z.boolean(),
  /** Why the text was not shown to Laya, or the flag raised on it: the finding's text tries to instruct an agent. */
  injects: z.string().max(300).optional(),
  /** Laya's decision in the log, to say it was wrong. */
  decision: z.string().optional(),
  at: z.string(),
});
export type FindingTriage = z.infer<typeof FindingTriageSchema>;

/** The start of the reason a finding carries when Laya's triage dismissed it. Not a judgement by the owner. */
export const TRIAGE_DISMISS = "Triage by Laya";

export const FindingSchema = z.object({
  id: z.number().int().positive(),
  /** The workspace (an org id, or `private`). */
  org: IdSchema,
  project: IdSchema.optional(),
  source: FindingSourceSchema,
  /** One line. */
  title: z.string(),
  detail: z.string(),
  /** Links, file:line, commands that were run. */
  evidence: z.array(z.string()),
  severity: FindingSeveritySchema,
  /** The goal it serves (an id; there is no goals table yet). */
  goal: IdSchema.optional(),
  /** The playbook that reported it. */
  playbook: IdSchema.optional(),
  /** Where an output of it would go if it left this machine (an email, a post, a form). Nothing is sent without approval. */
  channel: z.string().optional(),
  /** The same key is the same finding: reporting it again only refreshes `lastSeen`. */
  dedupeKey: z.string(),
  status: FindingStatusSchema,
  /** The task made from it, while `status` is `proposed`, `task` or `fixed`. */
  task: TaskIdSchema.optional(),
  /** The decision it was handed over as. */
  decision: z.string().optional(),
  dismissedReason: z.string().optional(),
  /** Laya's triage of it, when it ran. */
  triage: FindingTriageSchema.optional(),
  /** Who reported it first: `owner`, `captain` or an agent id. */
  by: z.string(),
  /** How many times it was reported. */
  seen: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastSeen: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

const Text = (max: number) => z.string().trim().min(1).max(max);

export const FindingsListInputSchema = z.object({
  org: IdSchema.optional(),
  project: IdSchema.optional(),
  source: FindingSourceSchema.optional(),
  /** One status, or `live` for every finding that is not dismissed or fixed. */
  status: z.union([FindingStatusSchema, z.literal("live")]).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type FindingsListInput = z.infer<typeof FindingsListInputSchema>;

export const FindingsListSchema = z.object({
  findings: z.array(FindingSchema),
  /** Findings still open, in the filtered workspace. */
  open: z.number().int().min(0),
  /** Open findings first seen in the last day. */
  fresh: z.number().int().min(0),
});
export type FindingsList = z.infer<typeof FindingsListSchema>;

export const FindingReportInputSchema = z.object({
  /** The workspace. An agent or a captain lane reports into its own workspace only; this is ignored for them. */
  org: IdSchema.optional(),
  project: IdSchema.optional(),
  source: FindingSourceSchema,
  title: Text(200),
  detail: z.string().trim().max(4000).default(""),
  evidence: z.array(Text(500)).max(20).default([]),
  severity: FindingSeveritySchema.default("info"),
  goal: IdSchema.optional(),
  playbook: IdSchema.optional(),
  channel: Text(100).optional(),
  /** What makes two reports the same finding. Default: the source, the project and the title. */
  dedupeKey: Text(300).optional(),
});
export type FindingReportInput = z.infer<typeof FindingReportInputSchema>;

export const FindingReportResultSchema = z.object({
  finding: FindingSchema,
  /** `created`, `refreshed` when the dedupe key was known, or `reopened` when a fixed finding came back. */
  result: z.enum(["created", "refreshed", "reopened"]),
});
export type FindingReportResult = z.infer<typeof FindingReportResultSchema>;

export const FindingUpdateInputSchema = z.object({
  id: z.number().int().positive(),
  /** `proposed` comes from findings.toTask and `dismissed` from findings.dismiss. */
  status: z.enum(["open", "task", "decision", "fixed"]).optional(),
  severity: FindingSeveritySchema.optional(),
  title: Text(200).optional(),
  detail: z.string().trim().max(4000).optional(),
  /** The task a `task` status points at. */
  task: TaskIdSchema.optional(),
  /** The decision a `decision` status points at. */
  decision: Text(300).optional(),
});
export type FindingUpdateInput = z.infer<typeof FindingUpdateInputSchema>;

export const FindingToTaskInputSchema = z.object({ id: z.number().int().positive() });

export const FindingToTaskResultSchema = z.object({
  finding: FindingSchema,
  task: TaskIdSchema,
});
export type FindingToTaskResult = z.infer<typeof FindingToTaskResultSchema>;

export const FindingDismissInputSchema = z.object({
  id: z.number().int().positive(),
  reason: Text(500),
});
