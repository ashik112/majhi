import { z } from "zod";
import { CaptainChoreSchema } from "./captain.ts";
import { IdSchema } from "./ids.ts";

/**
 * Playbooks, goals and the outbound gate (SPEC 5.18, "Playbooks"; captain v2 step 6). A playbook is
 * the one unit of standing work: data with a trigger, a scope, inputs, steps, outputs, a cost tier and
 * a goal. One scheduler fires them. Everything that would leave the machine passes the outbound gate.
 */

// ---------------------------------------------------------------------------
// Packs

export const PLAYBOOK_PACKS = ["upkeep", "engineering", "ops"] as const;
export const PlaybookPackSchema = z.enum(PLAYBOOK_PACKS);
export type PlaybookPack = z.infer<typeof PlaybookPackSchema>;

export const PLAYBOOK_PACK_LABEL: Record<PlaybookPack, string> = {
  upkeep: "Upkeep",
  engineering: "Engineering",
  ops: "Ops watch",
};

/** One line under a pack's name. */
export const PLAYBOOK_PACK_NOTE: Record<PlaybookPack, string> = {
  upkeep: "The captain's standing chores: shipping, cards, questions, memory, projects, triage, cleanup.",
  engineering: "Health checks that file findings. They need sensors that are not built yet.",
  ops: "Checks that a service is up. A failure files an incident and wakes the captain.",
};

// ---------------------------------------------------------------------------
// Cadence

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24 hours");

/**
 * When a playbook is due. `events` and `manual` never fire on a clock: it runs when something it
 * listens for happens, or when the owner presses Run now.
 */
export const CadenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("events") }),
  /** Every N minutes since the last run. */
  z.object({ kind: z.literal("every"), minutes: z.number().int().min(5).max(10_080) }),
  /** Once a day, from `at` in the workspace's time zone. */
  z.object({ kind: z.literal("daily"), at: Clock.default("00:00") }),
  /** Once a week, on `day` (0 is Sunday) from `at`. */
  z.object({ kind: z.literal("weekly"), day: z.number().int().min(0).max(6), at: Clock.default("08:00") }),
]);
export type Cadence = z.infer<typeof CadenceSchema>;

/** A stretch of the day in which a playbook does not start. It may wrap midnight (22:00 to 07:00). */
export const QuietHoursSchema = z.object({ from: Clock, to: Clock });
export type QuietHours = z.infer<typeof QuietHoursSchema>;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "Every hour", "Daily at 08:00", "Mondays at 09:00", "When something happens", "On demand". */
export function cadenceLabel(c: Cadence): string {
  switch (c.kind) {
    case "manual":
      return "On demand";
    case "events":
      return "When something happens";
    case "every":
      if (c.minutes === 60) return "Every hour";
      if (c.minutes % 60 === 0) return `Every ${c.minutes / 60} hours`;
      return `Every ${c.minutes} minutes`;
    case "daily":
      return c.at === "00:00" ? "Daily" : `Daily at ${c.at}`;
    case "weekly":
      return `${DAY_NAMES[c.day]}s at ${c.at}`;
  }
}

// ---------------------------------------------------------------------------
// The playbook

/** What a playbook may produce. Anything that leaves the machine is a draft and passes the gate. */
export const PlaybookOutputSchema = z.enum(["finding", "task", "draft", "decision", "log"]);
export type PlaybookOutput = z.infer<typeof PlaybookOutputSchema>;

/** Who does the work, cheapest first: code, Laya (local, free), a small model, the big model. */
export const CostTierSchema = z.enum(["rules", "laya", "small", "big"]);
export type CostTier = z.infer<typeof CostTierSchema>;

export const COST_TIER_LABEL: Record<CostTier, string> = {
  rules: "Rules",
  laya: "Laya",
  small: "Small model",
  big: "Big model",
};

/**
 * How a run is carried out. `chore`: one of the upkeep chores, under the runner's guards. `rules`:
 * code that needs no model (`id` names it). `captain`: a news wake in the workspace's lane.
 */
export const PlaybookRunnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chore"), chore: CaptainChoreSchema }),
  z.object({ kind: z.literal("rules"), id: IdSchema }),
  z.object({ kind: z.literal("captain") }),
]);
export type PlaybookRunner = z.infer<typeof PlaybookRunnerSchema>;

export const PlaybookSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(60),
  pack: PlaybookPackSchema,
  /** One line: why it exists. */
  purpose: z.string().trim().min(1).max(160),
  trigger: z.object({
    cadence: CadenceSchema,
    /** Events or sensors that also start it ("A task reaches review"). Shown, not configured. */
    events: z.array(z.string().max(120)).max(10).default([]),
  }),
  /** `workspace`: runs in each workspace it is on in. `business`: once, from the Private lane. */
  scope: z.enum(["workspace", "business"]).default("workspace"),
  /** What it may read, in words ("tasks in review", "the URLs listed below"). */
  inputs: z.array(z.string().max(120)).max(12),
  /** The instruction the captain follows. Data: it never grows into code. */
  steps: z.string().trim().min(1).max(4000),
  outputs: z.array(PlaybookOutputSchema).min(1),
  /** Outbound channels it may draft for. */
  channels: z.array(IdSchema).max(8).default([]),
  cost: z.object({
    tier: CostTierSchema,
    /** Tokens one run may spend. A run that reaches it ends. 0 for rules. */
    tokens: z.number().int().min(0).max(500_000),
  }),
  /** On in a workspace the first time its list is read? */
  enabledByDefault: z.boolean().default(false),
  /**
   * Reads only and files findings, which wait for the owner. A read-only rules playbook runs when
   * Autonomous is off and when Upkeep is on You, because nothing it does acts on anything.
   */
  readOnly: z.boolean().optional(),
  /** Why it cannot run yet ("needs a CI sensor"), when something it depends on is not built. */
  needs: z.string().max(200).optional(),
  /** What turning it on does, in a sentence, shown beside the switch. */
  turnOn: z.string().max(240),
  runner: PlaybookRunnerSchema,
  /** Names of settings the owner fills in, like the URLs of an uptime check. */
  settings: z
    .array(z.object({ key: IdSchema, label: z.string().max(60), hint: z.string().max(160).default("") }))
    .max(4)
    .default([]),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

// ---------------------------------------------------------------------------
// Per-workspace state and the view the owner reads

/** What the owner changed for one playbook in one workspace. Anything missing is the playbook's default. */
export const PlaybookStateSchema = z.object({
  enabled: z.boolean().optional(),
  cadence: CadenceSchema.optional(),
  quiet: QuietHoursSchema.nullable().optional(),
  /** The goal it serves in this workspace. */
  goal: IdSchema.nullable().optional(),
  /** Values for the playbook's `settings`, one list of lines each. */
  settings: z.record(IdSchema, z.array(z.string().max(500)).max(50)).optional(),
});
export type PlaybookState = z.infer<typeof PlaybookStateSchema>;

export const PlaybookRunStatusSchema = z.enum([
  "running",
  "done",
  /** Nothing new: archived quietly. */
  "nothing",
  "failed",
  "capped",
  "stopped",
]);
export type PlaybookRunStatus = z.infer<typeof PlaybookRunStatusSchema>;

export const PlaybookRunSchema = z.object({
  id: z.number().int().positive(),
  org: IdSchema,
  playbook: IdSchema,
  trigger: z.string(),
  status: PlaybookRunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  /** One line: what it found, or why it ended. */
  note: z.string().optional(),
  findings: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});
export type PlaybookRun = z.infer<typeof PlaybookRunSchema>;

export const PlaybookCountersSchema = z.object({
  ran: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
  /** What an upkeep chore did or handed to the owner (its log lines). Findings are for the playbooks that file them. */
  acted: z.number().int().nonnegative().default(0),
});
export type PlaybookCounters = z.infer<typeof PlaybookCountersSchema>;

export const PlaybookViewSchema = z.object({
  playbook: PlaybookSchema,
  org: IdSchema,
  enabled: z.boolean(),
  cadence: CadenceSchema,
  quiet: QuietHoursSchema.optional(),
  goal: IdSchema.optional(),
  settings: z.record(z.string(), z.array(z.string())),
  /** Why it will not fire now: Delegation, Autonomous off, off after failures, a backoff, needs a sensor. */
  held: z.string().optional(),
  running: z.boolean(),
  lastRun: z.string().optional(),
  lastNote: z.string().optional(),
  nextRun: z.string().optional(),
  counters: PlaybookCountersSchema,
});
export type PlaybookView = z.infer<typeof PlaybookViewSchema>;

export const PlaybooksListInputSchema = z.object({ org: IdSchema.optional() });
export const PlaybooksListSchema = z.object({
  org: IdSchema,
  playbooks: z.array(PlaybookViewSchema),
});
export type PlaybooksList = z.infer<typeof PlaybooksListSchema>;

export const PlaybookUpdateInputSchema = z.object({
  org: IdSchema,
  id: IdSchema,
  enabled: z.boolean().optional(),
  cadence: CadenceSchema.optional(),
  quiet: QuietHoursSchema.nullable().optional(),
  goal: IdSchema.nullable().optional(),
  settings: z.record(IdSchema, z.array(z.string().trim().min(1).max(500)).max(50)).optional(),
});
export type PlaybookUpdateInput = z.infer<typeof PlaybookUpdateInputSchema>;

export const PlaybookRunNowInputSchema = z.object({ org: IdSchema, id: IdSchema });
export const PlaybookRunNowResultSchema = z.object({ started: z.boolean(), text: z.string() });
export type PlaybookRunNowResult = z.infer<typeof PlaybookRunNowResultSchema>;

export const PlaybookRunsInputSchema = z.object({
  org: IdSchema,
  id: IdSchema,
  limit: z.number().int().min(1).max(100).default(20),
});
export const PlaybookRunsSchema = z.object({ runs: z.array(PlaybookRunSchema) });

/**
 * The captain closes a run it was woken for. `nothing`: nothing new, archived quietly. `done`: it
 * reported what it found as findings. `blocked`: it could not do the steps, and says why.
 */
export const PlaybookReportInputSchema = z.object({
  run: z.number().int().positive(),
  outcome: z.enum(["done", "nothing", "blocked"]),
  summary: z.string().trim().max(400).default(""),
});
export const PlaybookReportResultSchema = z.object({ run: PlaybookRunSchema });

// ---------------------------------------------------------------------------
// Goals

export const GoalStatusSchema = z.enum(["proposed", "active", "done", "dropped"]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  proposed: "Proposed",
  active: "Active",
  done: "Done",
  dropped: "Dropped",
};

export const GoalSchema = z.object({
  id: IdSchema,
  /** The workspace, or `business` for a goal across all of them. */
  org: z.string().min(1).max(63),
  title: z.string(),
  /** What is measured ("monthly revenue", "uptime"). */
  metric: z.string().optional(),
  /** The value to reach ("$10k", "99.9%"). */
  target: z.string().optional(),
  /** A date, `YYYY-MM-DD`. */
  due: z.string().optional(),
  status: GoalStatusSchema,
  /** `owner` or `captain`. A captain goal waits as proposed until the owner confirms. */
  by: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Goal = z.infer<typeof GoalSchema>;

/** The scope word for a goal that belongs to the whole business. */
export const BUSINESS = "business";

const Short = (max: number) => z.string().trim().min(1).max(max);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const GoalsListInputSchema = z.object({
  org: z.string().min(1).max(63).optional(),
  status: GoalStatusSchema.optional(),
});
export type GoalsListInput = z.infer<typeof GoalsListInputSchema>;
export const GoalsListSchema = z.object({ goals: z.array(GoalSchema) });

export const GoalCreateInputSchema = z.object({
  /** A workspace id, or `business`. A captain lane creates in its own workspace only. */
  org: z.string().min(1).max(63).default(BUSINESS),
  title: Short(140),
  metric: Short(80).optional(),
  target: Short(80).optional(),
  due: Day.optional(),
});
export type GoalCreateInput = z.infer<typeof GoalCreateInputSchema>;

export const GoalUpdateInputSchema = z.object({
  id: IdSchema,
  title: Short(140).optional(),
  metric: Short(80).nullable().optional(),
  target: Short(80).nullable().optional(),
  due: Day.nullable().optional(),
  /** Confirming a proposal, finishing or dropping a goal. The owner's. */
  status: GoalStatusSchema.optional(),
});
export type GoalUpdateInput = z.infer<typeof GoalUpdateInputSchema>;

export const GoalRemoveInputSchema = z.object({ id: IdSchema });

// ---------------------------------------------------------------------------
// The outbound gate

/** What leaves the machine. Each kind is a channel per workspace. */
export const OUTBOUND_CHANNELS = ["email", "post", "tracker-comment", "form", "message"] as const;
export const OutboundChannelSchema = z.enum(OUTBOUND_CHANNELS);
export type OutboundChannel = z.infer<typeof OutboundChannelSchema>;

export const OUTBOUND_CHANNEL_LABEL: Record<OutboundChannel, string> = {
  email: "Email",
  post: "Social post",
  "tracker-comment": "Public tracker comment",
  form: "Form submit",
  message: "Message",
};

/** Draft: the owner approves each. Batch: the owner approves a batch on a schedule. Auto: allowed within a daily limit. */
export const OutboundModeSchema = z.enum(["draft", "batch", "auto"]);
export type OutboundMode = z.infer<typeof OutboundModeSchema>;

export const OUTBOUND_MODE_LABEL: Record<OutboundMode, string> = {
  draft: "Draft",
  batch: "Batch",
  auto: "Auto",
};

/** Sends one channel allows per day in Auto, until the trust ladder (step 8) sets its own. */
export const AUTO_DAILY_LIMIT = 5;

export const OutboundChannelStateSchema = z.object({
  org: IdSchema,
  channel: OutboundChannelSchema,
  mode: OutboundModeSchema,
  /** The hour batches are put in front of the owner (`HH:MM`, the workspace's zone). */
  batchAt: Clock,
  /** The owner switched Auto on for this channel on purpose. */
  autoSetByOwner: z.boolean(),
});
export type OutboundChannelState = z.infer<typeof OutboundChannelStateSchema>;

export const DraftStatusSchema = z.enum(["pending", "queued", "approved", "sent", "discarded", "failed"]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

export const DRAFT_STATUS_LABEL: Record<DraftStatus, string> = {
  pending: "Waits for you",
  queued: "In the next batch",
  approved: "Approved, not sent",
  sent: "Sent",
  discarded: "Discarded",
  failed: "Failed",
};

export const DraftSchema = z.object({
  id: z.number().int().positive(),
  org: IdSchema,
  channel: OutboundChannelSchema,
  /** Who or where it goes: an address, a thread, a handle, a URL. */
  target: z.string(),
  subject: z.string().optional(),
  body: z.string(),
  /** The voice profile used, when there was one. */
  voice: z.string().optional(),
  playbook: IdSchema.optional(),
  finding: z.number().int().positive().optional(),
  status: DraftStatusSchema,
  /** The mode that decided its path, at the time. */
  mode: OutboundModeSchema,
  /** What happened when it was released: sent, or why not. */
  result: z.string().optional(),
  by: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

export const OutboundListInputSchema = z.object({ org: IdSchema.optional() });
export const OutboundListSchema = z.object({
  channels: z.array(OutboundChannelStateSchema),
  drafts: z.array(DraftSchema),
});
export type OutboundList = z.infer<typeof OutboundListSchema>;

export const OutboundSetModeInputSchema = z.object({
  org: IdSchema,
  channel: OutboundChannelSchema,
  mode: OutboundModeSchema.optional(),
  batchAt: Clock.optional(),
  /** Needed for Auto: the owner says it on purpose. The screen does not offer it before the trust ladder. */
  explicit: z.boolean().optional(),
});

export type OutboundSetModeInput = z.infer<typeof OutboundSetModeInputSchema>;

/** The gate. A captain lane or an agent submits; the channel's mode decides the path. */
export const OutboundSubmitInputSchema = z.object({
  /** The workspace. A captain lane submits for its own workspace only. */
  org: IdSchema.optional(),
  channel: OutboundChannelSchema,
  target: Short(500),
  subject: Short(200).optional(),
  body: Short(20_000),
  voice: Short(100).optional(),
  playbook: IdSchema.optional(),
  finding: z.number().int().positive().optional(),
});
export type OutboundSubmitInput = z.infer<typeof OutboundSubmitInputSchema>;

export const OutboundSubmitResultSchema = z.object({
  draft: DraftSchema,
  /** One line for the caller: "Waits for the owner's approval." */
  text: z.string(),
});

export const OutboundDecideInputSchema = z.object({
  id: z.number().int().positive(),
  decision: z.enum(["send", "discard"]),
});
export const OutboundBatchInputSchema = z.object({
  org: IdSchema,
  channel: OutboundChannelSchema,
  decision: z.enum(["send", "discard"]),
});
export const OutboundDecideResultSchema = z.object({ drafts: z.array(DraftSchema) });

/** The decision ids of the outbound gate in the Decisions inbox. */
export function draftDecisionId(id: number): string {
  return `draft:${id}`;
}
export function batchDecisionId(org: string, channel: string): string {
  return `batch:${org}:${channel}`;
}
