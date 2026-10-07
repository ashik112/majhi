import { z } from "zod";
import { IdSchema } from "./ids.ts";

/**
 * The ops watch pack (SPEC 5.18, "Ops watch"): the services the owner declares per workspace, the
 * cheap checks that watch them, the incidents a confirmed failure opens, and the phone push that
 * reaches the owner away from the screen. Nothing here carries a secret: the phone topic lives in
 * secrets.age and is shown once, when it is made.
 */

export const OpsServiceIdSchema = z.string().regex(/^svc-[a-z0-9]{4,12}$/);

/** How bad it is when this service is down. It sets the incident's severity. */
export const OpsImpactSchema = z.enum(["high", "medium", "low"]);
export type OpsImpact = z.infer<typeof OpsImpactSchema>;

export const OPS_IMPACT_LABEL: Record<OpsImpact, string> = {
  high: "Customers feel it",
  medium: "Some work stops",
  low: "Nobody notices at once",
};

/** A monitoring service reached through one of the workspace's MCP connections: one read tool, one number. */
export const OpsMonitorSchema = z.object({
  /** The connection id (type `mcp`, remote). */
  connection: IdSchema,
  /** The tool that reads, like `get_error_rate`. majhi calls it as given: it must only read. */
  tool: z.string().trim().min(1).max(120),
  /** The tool's arguments as a JSON object. */
  args: z.string().max(2000).default("{}"),
  /** Where the number sits in the answer, like `data.errorRate` or `rows.0.value`. */
  path: z.string().trim().min(1).max(200),
  /** The service counts as failing above this value. */
  max: z.number().finite(),
  /** What the number is, for the screen ("error rate %"). */
  label: z.string().trim().max(60).default("value"),
});
export type OpsMonitor = z.infer<typeof OpsMonitorSchema>;

export const OpsServiceDefSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** The address checked. http or https, no sign-in inside it. */
  url: z.string().trim().min(1).max(500),
  /** An exact status that counts as up. Absent: anything below 400. */
  expectStatus: z.number().int().min(100).max(599).optional(),
  /** Text the page must contain. Only whether it is there is ever kept. */
  keyword: z.string().max(200).optional(),
  /** Slower than this (to the first byte) counts as failing. */
  maxLatencyMs: z.number().int().min(50).max(60_000).optional(),
  /** Watch the certificate (https only). */
  tls: z.boolean().default(false),
  /** Watch that the host name resolves. */
  dns: z.boolean().default(false),
  impact: OpsImpactSchema.default("medium"),
  /** The project a fix task opens in. */
  project: IdSchema.optional(),
  monitor: OpsMonitorSchema.optional(),
});
export type OpsServiceDef = z.infer<typeof OpsServiceDefSchema>;

export const OpsCheckKindSchema = z.enum(["url", "tls", "dns", "monitor", "watch"]);
export type OpsCheckKind = z.infer<typeof OpsCheckKindSchema>;

export const OpsCheckStatusSchema = z.enum([
  /** Not looked at yet. */
  "new",
  "up",
  /** One failure not yet confirmed (flapping protection). */
  "checking",
  "down",
  /** majhi cannot tell: no network here, or the monitoring connection is gone. Never an incident. */
  "unknown",
]);
export type OpsCheckStatus = z.infer<typeof OpsCheckStatusSchema>;

export const OpsCheckViewSchema = z.object({
  kind: OpsCheckKindSchema,
  status: OpsCheckStatusSchema,
  /** One plain line: "status 503", "certificate expires in 10 days". */
  detail: z.string(),
  at: z.string().optional(),
  ms: z.number().int().nonnegative().optional(),
});
export type OpsCheckView = z.infer<typeof OpsCheckViewSchema>;

export const OpsSampleSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  ms: z.number().int().nonnegative().nullable(),
});
export type OpsSample = z.infer<typeof OpsSampleSchema>;

export const OpsServiceViewSchema = z.object({
  id: OpsServiceIdSchema,
  org: IdSchema,
  def: OpsServiceDefSchema,
  /** The worst of its checks. */
  status: OpsCheckStatusSchema,
  checks: z.array(OpsCheckViewSchema),
  /** The last 24 hours of the address check, at most 96 points. */
  samples: z.array(OpsSampleSchema),
  /** Share of the last 24 hours the address answered, 0 to 100. Absent before the first check. */
  uptime: z.number().min(0).max(100).optional(),
  incident: z.number().int().positive().optional(),
});
export type OpsServiceView = z.infer<typeof OpsServiceViewSchema>;

export const OpsTimelineEntrySchema = z.object({
  at: z.string(),
  /** opened, alerted, escalated, acked, action (what the captain did), reopened, resolved. */
  kind: z.enum(["opened", "alerted", "escalated", "acked", "action", "reopened", "resolved", "note"]),
  /** Kept whole up to 8000 characters: an error's cause often comes after a long command line. */
  text: z.string().max(8000),
});
export type OpsTimelineEntry = z.infer<typeof OpsTimelineEntrySchema>;

export const OpsIncidentSchema = z.object({
  id: z.number().int().positive(),
  org: IdSchema,
  /** Absent for majhi's own checks. */
  service: OpsServiceIdSchema.optional(),
  /** The watch (Watch anything) this incident belongs to. */
  watch: z
    .string()
    .regex(/^wch-[a-z0-9]{4,12}$/)
    .optional(),
  title: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  status: z.enum(["open", "resolved"]),
  finding: z.number().int().positive().optional(),
  openedAt: z.string(),
  ackedAt: z.string().optional(),
  escalatedAt: z.string().optional(),
  resolvedAt: z.string().optional(),
  /** Times it came back within the reopen window instead of starting a new incident. */
  flaps: z.number().int().nonnegative(),
  /** The incident task the engine opened or joined for it. Read from the task links, not stored on the incident. */
  task: z.string().optional(),
  /** Why nobody looked at it: "Auto-pilot is off", "The captain rests: outside working hours (09:00 to 18:00)". */
  quiet: z.string().optional(),
  /** A Health fix the owner can press, for majhi's own checks. */
  fix: z.object({ check: z.string(), label: z.string() }).optional(),
  timeline: z.array(OpsTimelineEntrySchema),
});
export type OpsIncident = z.infer<typeof OpsIncidentSchema>;

export const OpsActionsSchema = z.object({
  /** Approve or Leave buttons on permission requests. */
  approval: z.boolean().default(false),
  /** ... on work ready to merge. */
  ship: z.boolean().default(false),
  /** ... on outbound drafts. */
  draft: z.boolean().default(false),
});
export type OpsActions = z.infer<typeof OpsActionsSchema>;

export const OpsPhoneStatusSchema = z.object({
  /** off: never set up. paused: set up, switched off. on: pushes go out. */
  state: z.enum(["off", "paused", "on"]),
  server: z.string().optional(),
  /** Whether a topic is stored. The topic itself is never returned after setup. */
  hasTopic: z.boolean(),
  /** The address your phone reaches majhi on, for Open and the buttons. */
  address: z.string().optional(),
  actions: OpsActionsSchema,
  /** Action buttons need an address and at least one switch on. */
  buttons: z.boolean(),
  lastSentAt: z.string().optional(),
  lastError: z.string().optional(),
});
export type OpsPhoneStatus = z.infer<typeof OpsPhoneStatusSchema>;

export const OpsSettingsSchema = z.object({
  /** An unanswered high incident alerts again after this many minutes. */
  escalateMin: z.number().int().min(1).max(240),
  /** Checks green this long close an incident. */
  resolveMin: z.number().int().min(1).max(240),
});
export type OpsSettings = z.infer<typeof OpsSettingsSchema>;
export const OPS_DEFAULTS: OpsSettings = { escalateMin: 10, resolveMin: 10 };

export const OpsOverviewSchema = z.object({
  services: z.array(OpsServiceViewSchema),
  /** Open ones first, then the 30 most recent resolved. */
  incidents: z.array(OpsIncidentSchema),
  phone: OpsPhoneStatusSchema,
  settings: OpsSettingsSchema,
});
export type OpsOverview = z.infer<typeof OpsOverviewSchema>;

export const OpsOverviewInputSchema = z.object({ org: IdSchema.optional() });

export const OpsServiceSaveInputSchema = OpsServiceDefSchema.extend({
  /** Absent to add one. */
  id: OpsServiceIdSchema.optional(),
  org: IdSchema,
});
export type OpsServiceSaveInput = z.infer<typeof OpsServiceSaveInputSchema>;

export const OpsServiceIdInputSchema = z.object({ id: OpsServiceIdSchema });
export const OpsAckInputSchema = z.object({ id: z.number().int().positive() });

export const OpsSettingsInputSchema = OpsSettingsSchema.partial();

export const OpsPhoneSetupInputSchema = z.object({
  /** An ntfy server. Absent: ntfy.sh. */
  server: z.string().trim().max(200).optional(),
  /** An access token for a protected self-hosted server. Stored in secrets.age. */
  token: z.string().trim().min(1).max(300).optional(),
});

/** What setup returns, once. The topic is the only thing that can read or send to this phone's channel. */
export const OpsPhoneSetupResultSchema = z.object({
  server: z.string(),
  topic: z.string(),
  /** What the QR code holds: the ntfy app opens it and subscribes. */
  link: z.string(),
  status: OpsPhoneStatusSchema,
});
export type OpsPhoneSetupResult = z.infer<typeof OpsPhoneSetupResultSchema>;

export const OpsPhoneSetInputSchema = z.object({
  enabled: z.boolean().optional(),
  /** null clears it. */
  address: z.string().trim().max(200).nullable().optional(),
  actions: OpsActionsSchema.partial().optional(),
});
export type OpsPhoneSetInput = z.infer<typeof OpsPhoneSetInputSchema>;

export const OpsPhoneTestResultSchema = z.object({ sent: z.boolean(), error: z.string().optional() });

/** A decision the phone can act on, and the buttons. Fixed vocabulary: nothing from a task reaches a push. */
export const PHONE_ACTIONS = ["approve", "leave", "ack"] as const;
export const PhoneActionSchema = z.enum(PHONE_ACTIONS);
export type PhoneAction = z.infer<typeof PhoneActionSchema>;

/** Wrong or reused links say the same thing, so they teach an attacker nothing. */
export const PHONE_LINK_REFUSED = "This link does not work. Open majhi to answer.";

export function incidentDecisionId(id: number): string {
  return `incident:${id}`;
}
