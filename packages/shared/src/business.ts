import { z } from "zod";
import { IdSchema } from "./ids.ts";
import { AttachmentSchema } from "./tasks.ts";

/**
 * The business memory the growth, social and inbox packs draw on (SPEC 5.19): a knowledge base, a voice
 * profile, a light CRM and a list of deadlines. Every row belongs to one workspace or, with no `org`, to
 * the whole business. A captain lane or an agent reads its own workspace's rows and the business rows
 * only. Text in these rows is data for a draft, never an instruction.
 */

const Text = (max: number) => z.string().trim().min(1).max(max);
const Tag = z.string().trim().min(1).max(40);
const Tags = z.array(Tag).max(20).default([]);

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
// Knowledge base

export const KB_KINDS = [
  "about",
  "product",
  "pricing",
  "positioning",
  "win",
  "metric",
  "bio",
  "asset",
  "faq",
  "policy",
] as const;
export const KbKindSchema = z.enum(KB_KINDS);
export type KbKind = z.infer<typeof KbKindSchema>;

export const KB_KIND_LABEL: Record<KbKind, string> = {
  about: "About",
  product: "Product",
  pricing: "Pricing",
  positioning: "Positioning",
  win: "Win or case study",
  metric: "Metric",
  bio: "Bio",
  asset: "Asset",
  faq: "FAQ",
  policy: "Policy",
};

export const KB_BODY_MAX = 40_000;

export const KbEntrySchema = z.object({
  id: z.number().int().positive(),
  /** The workspace; absent for the whole business. */
  org: IdSchema.optional(),
  kind: KbKindSchema,
  title: z.string(),
  /** Markdown. */
  body: z.string(),
  tags: z.array(z.string()),
  /** Links or notes that say where the facts came from. */
  sources: z.array(z.string()),
  /** Files kept with an asset or a case study (from the uploads mechanism). */
  files: z.array(AttachmentSchema),
  /** The owner checked this. An unverified entry is a proposal: drafts say so. */
  verified: z.boolean(),
  verifiedAt: z.string().optional(),
  version: z.number().int().positive(),
  /** `owner`, `captain` or an agent id. */
  by: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KbEntry = z.infer<typeof KbEntrySchema>;

/** A row in a list: the body is cut to a short excerpt. */
export const KbRowSchema = KbEntrySchema.omit({ body: true }).extend({ excerpt: z.string() });
export type KbRow = z.infer<typeof KbRowSchema>;

export const KbVersionSchema = z.object({
  version: z.number().int().positive(),
  title: z.string(),
  kind: KbKindSchema,
  by: z.string(),
  at: z.string(),
  verified: z.boolean(),
  change: z.enum(["create", "edit", "verify", "restore", "remove"]),
});
export type KbVersion = z.infer<typeof KbVersionSchema>;

export const KbListInputSchema = ScopeFilterSchema.extend({
  kind: KbKindSchema.optional(),
  tag: Tag.optional(),
  verified: z.boolean().optional(),
  /** Only removed entries (the owner's Undo list). */
  removed: z.boolean().optional(),
  limit: z.number().int().min(1).max(2000).default(500),
});
export type KbListInput = z.infer<typeof KbListInputSchema>;
export const KbListSchema = z.object({
  entries: z.array(KbRowSchema),
  total: z.number().int().nonnegative(),
});
export type KbList = z.infer<typeof KbListSchema>;

export const KbGetInputSchema = z.object({
  id: z.number().int().positive(),
  /** An older version's text instead of the current one. */
  version: z.number().int().positive().optional(),
});
export const KbGetSchema = z.object({
  entry: KbEntrySchema,
  versions: z.array(KbVersionSchema),
  removed: z.boolean(),
});
export type KbGet = z.infer<typeof KbGetSchema>;

export const KbUpsertInputSchema = z.object({
  /** Absent: a new entry. */
  id: z.number().int().positive().optional(),
  /** A workspace id; absent for the whole business. */
  org: IdSchema.optional(),
  kind: KbKindSchema,
  title: Text(200),
  body: z.string().max(KB_BODY_MAX).default(""),
  tags: Tags,
  sources: z.array(Text(500)).max(20).default([]),
  /** Upload ids from the Attach button, kept with the entry. */
  uploads: z.array(z.string()).max(10).default([]),
  /** The owner's only: mark it checked. The owner's own entries start verified. */
  verified: z.boolean().optional(),
});
export type KbUpsertInput = z.infer<typeof KbUpsertInputSchema>;
export const KbUpsertResultSchema = z.object({ entry: KbEntrySchema, created: z.boolean() });
export type KbUpsertResult = z.infer<typeof KbUpsertResultSchema>;

export const KbIdInputSchema = z.object({ id: z.number().int().positive() });
export const KbVerifyInputSchema = KbIdInputSchema.extend({ verified: z.boolean() });
export const KbRestoreInputSchema = KbIdInputSchema.extend({
  /** A version to bring back; absent brings a removed entry back as it was. */
  version: z.number().int().positive().optional(),
});

export const KbSearchInputSchema = ScopeFilterSchema.extend({
  query: Text(500),
  kind: KbKindSchema.optional(),
  limit: z.number().int().min(1).max(30).default(8),
});
export const KbHitSchema = z.object({ entry: KbEntrySchema, score: z.number() });
export const KbSearchSchema = z.object({
  hits: z.array(KbHitSchema),
  /** The embedding half did not run, so only keywords ranked the hits. */
  keywordOnly: z.boolean(),
});
export type KbSearch = z.infer<typeof KbSearchSchema>;

// ---------------------------------------------------------------------------
// Voice

export const VoiceFieldsSchema = z.object({
  /** How it sounds, in a sentence or two. */
  tone: z.string().trim().max(600).default(""),
  /** How long a post, a reply or a mail runs. */
  length: z.string().trim().max(400).default(""),
  use: z.array(Text(80)).max(40).default([]),
  avoid: z.array(Text(80)).max(40).default([]),
  signOffs: z.array(Text(120)).max(10).default([]),
  /** A few real lines in this voice. */
  examples: z.array(Text(1_500)).max(8).default([]),
  /** Text the owner pasted or approved, the captain builds the guide from. */
  samples: z.array(Text(4_000)).max(10).default([]),
});
export type VoiceFields = z.infer<typeof VoiceFieldsSchema>;

export const VoiceProfileSchema = VoiceFieldsSchema.extend({
  org: IdSchema.optional(),
  by: z.string(),
  updatedAt: z.string(),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

export const VoiceProposalSchema = VoiceFieldsSchema.extend({
  org: IdSchema.optional(),
  /** Why the captain thinks so, in a sentence. */
  why: z.string(),
  by: z.string(),
  at: z.string(),
});
export type VoiceProposal = z.infer<typeof VoiceProposalSchema>;

export const VoiceGetInputSchema = z.object({ org: IdSchema.optional() });
export const VoiceGetSchema = z.object({
  /** This scope's own profile. */
  own: VoiceProfileSchema.optional(),
  /** What a draft uses here: the workspace's own, else the business one. */
  effective: VoiceProfileSchema.optional(),
  inherited: z.boolean(),
  proposal: VoiceProposalSchema.optional(),
});
export type VoiceGet = z.infer<typeof VoiceGetSchema>;

export const VoiceSetInputSchema = VoiceFieldsSchema.extend({ org: IdSchema.optional() });
export type VoiceSetInput = z.infer<typeof VoiceSetInputSchema>;
export const VoiceProposeInputSchema = VoiceFieldsSchema.extend({
  org: IdSchema.optional(),
  why: Text(400),
});
export type VoiceProposeInput = z.infer<typeof VoiceProposeInputSchema>;
export const VoiceDecideInputSchema = z.object({ org: IdSchema.optional(), accept: z.boolean() });

// ---------------------------------------------------------------------------
// Light CRM

export const CRM_RELATIONS = [
  "client",
  "lead",
  "investor",
  "partner",
  "hackathon",
  "grant",
  "community",
  "other",
] as const;
export const CrmRelationSchema = z.enum(CRM_RELATIONS);
export type CrmRelation = z.infer<typeof CrmRelationSchema>;
export const CRM_RELATION_LABEL: Record<CrmRelation, string> = {
  client: "Client",
  lead: "Lead",
  investor: "Investor",
  partner: "Partner",
  hackathon: "Hackathon",
  grant: "Grant body",
  community: "Community",
  other: "Other",
};

/** The simple pipeline for leads and investors, in order. */
export const CRM_STAGES = ["new", "contacted", "talking", "proposal", "won", "lost"] as const;
export const CrmStageSchema = z.enum(CRM_STAGES);
export type CrmStage = z.infer<typeof CrmStageSchema>;
export const CRM_STAGE_LABEL: Record<CrmStage, string> = {
  new: "New",
  contacted: "Contacted",
  talking: "Talking",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};
/** Only these relations sit in the pipeline. */
export const CRM_PIPELINE_RELATIONS: readonly CrmRelation[] = ["lead", "investor"];

export const CRM_CHANNELS = ["mail", "call", "meeting", "chat", "social", "other"] as const;
export const CrmChannelSchema = z.enum(CRM_CHANNELS);
export type CrmChannel = z.infer<typeof CrmChannelSchema>;

export const CrmContactSchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(["person", "organisation"]),
  relation: CrmRelationSchema,
  name: z.string(),
  /** For a person: the company or organisation they are with. */
  company: z.string(),
  role: z.string(),
  links: z.array(z.string()),
  emails: z.array(z.string()),
  notes: z.string(),
  tags: z.array(z.string()),
  /** The workspace; absent for the whole business. */
  org: IdSchema.optional(),
  /** Hidden from the captain and every agent. */
  ownerOnly: z.boolean(),
  stage: CrmStageSchema.optional(),
  nextStep: z.string(),
  nextDue: IsoDaySchema.optional(),
  /** When the last interaction happened. */
  lastTouch: z.string().optional(),
  by: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CrmContact = z.infer<typeof CrmContactSchema>;

export const CrmInteractionSchema = z.object({
  id: z.number().int().positive(),
  contact: z.number().int().positive(),
  at: z.string(),
  channel: CrmChannelSchema,
  summary: z.string(),
  link: z.string().optional(),
  by: z.string(),
});
export type CrmInteraction = z.infer<typeof CrmInteractionSchema>;

export const CrmListInputSchema = ScopeFilterSchema.extend({
  relation: CrmRelationSchema.optional(),
  stage: CrmStageSchema.optional(),
  tag: Tag.optional(),
  /** Words in the name, company, emails, links, notes or tags. */
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(5000).default(1000),
});
export type CrmListInput = z.infer<typeof CrmListInputSchema>;
export const CrmListSchema = z.object({
  contacts: z.array(CrmContactSchema),
  total: z.number().int().nonnegative(),
});
export type CrmList = z.infer<typeof CrmListSchema>;

export const CrmGetInputSchema = z.object({ id: z.number().int().positive() });
export const CrmGetSchema = z.object({
  contact: CrmContactSchema,
  interactions: z.array(CrmInteractionSchema),
});
export type CrmGet = z.infer<typeof CrmGetSchema>;

const Email = z.string().trim().toLowerCase().email().max(254);
const Link = z.string().trim().min(3).max(500);

export const CrmUpsertInputSchema = z.object({
  /** Absent: a new contact, merged into a matching one (same email or link in the same scope). */
  id: z.number().int().positive().optional(),
  kind: z.enum(["person", "organisation"]).default("person"),
  relation: CrmRelationSchema.default("other"),
  name: Text(200),
  company: z.string().trim().max(200).default(""),
  role: z.string().trim().max(200).default(""),
  links: z.array(Link).max(20).default([]),
  emails: z.array(Email).max(20).default([]),
  notes: z.string().max(8_000).default(""),
  tags: Tags,
  org: IdSchema.optional(),
  ownerOnly: z.boolean().default(false),
  stage: CrmStageSchema.optional(),
  nextStep: z.string().trim().max(300).default(""),
  nextDue: IsoDaySchema.optional(),
});
export type CrmUpsertInput = z.infer<typeof CrmUpsertInputSchema>;

export const CrmConflictSchema = z.object({
  field: z.string(),
  kept: z.string(),
  other: z.string(),
});
export type CrmConflict = z.infer<typeof CrmConflictSchema>;

export const CrmUpsertResultSchema = z.object({
  contact: CrmContactSchema,
  result: z.enum(["created", "updated", "merged"]),
  /** Ids of the duplicates folded into this contact. */
  merged: z.array(z.number().int().positive()),
  conflicts: z.array(CrmConflictSchema),
});
export type CrmUpsertResult = z.infer<typeof CrmUpsertResultSchema>;

export const CrmLogInputSchema = z.object({
  contact: z.number().int().positive(),
  /** When it happened, default now. */
  at: z.string().datetime({ offset: true }).optional(),
  channel: CrmChannelSchema,
  summary: Text(2_000),
  link: Link.optional(),
});
export const CrmLogResultSchema = z.object({ interaction: CrmInteractionSchema, contact: CrmContactSchema });

export const CrmMergeInputSchema = z.object({
  keep: z.number().int().positive(),
  drop: z.number().int().positive(),
});
export const CrmMergeResultSchema = z.object({
  contact: CrmContactSchema,
  conflicts: z.array(CrmConflictSchema),
});

export const CrmIdInputSchema = z.object({ id: z.number().int().positive() });

export const CrmNextStepsInputSchema = ScopeFilterSchema.extend({
  /** Steps due on or before this day; default: a week from today. */
  until: IsoDaySchema.optional(),
  limit: z.number().int().min(1).max(500).default(50),
});
export const CrmStepSchema = z.object({
  contact: CrmContactSchema,
  due: IsoDaySchema,
  overdue: z.boolean(),
});
export const CrmNextStepsSchema = z.object({ steps: z.array(CrmStepSchema) });
export type CrmNextSteps = z.infer<typeof CrmNextStepsSchema>;

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
  contact: z.number().int().positive().optional(),
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
  contact: z.number().int().positive().optional(),
  status: DeadlineStatusSchema.default("open"),
});
export type DeadlineUpsertInput = z.infer<typeof DeadlineUpsertInputSchema>;
export const DeadlineIdInputSchema = z.object({ id: z.number().int().positive() });
