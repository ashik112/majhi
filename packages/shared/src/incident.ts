import { z } from "zod";
import { ChatAppSchema } from "./chat.ts";
import { TaskIdSchema } from "./ids.ts";

/**
 * Incidents seen by clients (docs/briefs/client-chats.md, phase 2). An incident is a task of type `incident`.
 * Client rooms link to it through its `client` task links; a watch incident links through the finding it
 * made. What the client is told is derived here from recorded facts, never stored: `clientStatus` is the one
 * place that says Investigating, Identified, Monitoring or Resolved.
 */

export const CLIENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export const ClientStatusSchema = z.enum(CLIENT_STATUSES);
export type ClientStatus = z.infer<typeof ClientStatusSchema>;

export const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

/** A workspace's incident settings, in its autonomy entry. Absent fields mean the defaults. */
export const IncidentSettingsSchema = z.strictObject({
  /** The watch stays green this long before the client is told it is resolved. */
  soakMin: z.number().int().min(1).max(240).optional(),
  /** While an incident is open, each client room hears from us at most this often. */
  cadenceMin: z.number().int().min(5).max(480).optional(),
});
export type IncidentSettings = z.infer<typeof IncidentSettingsSchema>;

export const INCIDENT_DEFAULTS = { soakMin: 15, cadenceMin: 30 } as const;

export function effectiveIncident(stored: IncidentSettings | undefined): {
  soakMin: number;
  cadenceMin: number;
} {
  return {
    soakMin: stored?.soakMin ?? INCIDENT_DEFAULTS.soakMin,
    cadenceMin: stored?.cadenceMin ?? INCIDENT_DEFAULTS.cadenceMin,
  };
}

/** What is recorded about an incident. Times are ISO strings in UTC. */
export interface StatusFacts {
  /** When the incident task was made. */
  openedAt: string;
  /** Each time a client said it was still broken after it was resolved. */
  reopenedAt: readonly string[];
  /** When the captain marked the cause, a fix task or branch appeared, or a fix was pushed or merged: the earliest. */
  identifiedAt?: string | undefined;
  /** When the last deploy of the fix went live, and every deploy of the task and its fix tasks is live. Absent: not live. */
  liveAt?: string | undefined;
  /** The linked watch: `greenAt` is when its incident closed, absent while it fires. Absent: no watch is linked. */
  watch?: { greenAt?: string | undefined } | undefined;
  /** When the task was done. */
  doneAt?: string | undefined;
  /** Some deploy of the task has not gone live (failed, rolled back, still running). */
  deploysPending: boolean;
  soakMin: number;
  now: string;
}

export interface StatusResult {
  status: ClientStatus;
  /** When each state began, for the states reached since the last reopen. */
  at: Partial<Record<ClientStatus, string>>;
  /** While the watch is green and soaking: when the soak ends. */
  soakEndsAt?: string;
}

const ms = (iso: string): number => Date.parse(iso);
const later = (a: string, b: string): string => (ms(a) >= ms(b) ? a : b);

/**
 * The status a client sees. Investigating while the incident is open. Identified once a cause is marked or a fix
 * exists. Monitoring once the fix is live. Resolved when the linked watch stayed green for the soak, or, with no
 * watch, when the task is done and its deploys are live. A client who says it is still broken after Resolved
 * reopens it: only what happened after that counts toward the next Resolved, so the client wins over a watch that
 * was green, and it takes a new fix live (or the task done again) to resolve it.
 */
export function clientStatus(f: StatusFacts): StatusResult {
  const from = f.reopenedAt.reduce<string>((a, b) => later(a, b), f.openedAt);
  const reopened = from !== f.openedAt;
  const since = (t: string | undefined): string | undefined =>
    t !== undefined && ms(t) > ms(from) ? t : undefined;

  const at: StatusResult["at"] = { investigating: from };
  const identifiedAt = since(f.identifiedAt);
  const liveAt = since(f.liveAt);
  const doneAt = since(f.doneAt);
  if (identifiedAt !== undefined) at.identified = identifiedAt;
  if (liveAt !== undefined) {
    at.monitoring = liveAt;
    // A fix that is live was found first.
    at.identified ??= liveAt;
  }

  let resolvedAt: string | undefined;
  let soakEndsAt: string | undefined;
  if (f.watch !== undefined) {
    const green = f.watch.greenAt;
    // After a reopen the earlier green means nothing alone: a new fix has to go live.
    if (green !== undefined && (!reopened || liveAt !== undefined)) {
      const since0 = liveAt === undefined ? green : later(green, liveAt);
      const end = new Date(ms(since0) + f.soakMin * 60_000).toISOString();
      if (ms(end) <= ms(f.now)) resolvedAt = end;
      else soakEndsAt = end;
    }
  } else if (doneAt !== undefined && !f.deploysPending) {
    resolvedAt = liveAt === undefined ? doneAt : later(doneAt, liveAt);
  }
  if (resolvedAt !== undefined) at.resolved = resolvedAt;

  const status: ClientStatus =
    resolvedAt !== undefined
      ? "resolved"
      : liveAt !== undefined
        ? "monitoring"
        : at.identified !== undefined
          ? "identified"
          : "investigating";
  return { status, at, ...(soakEndsAt === undefined ? {} : { soakEndsAt }) };
}

// ---------------------------------------------------------------------------
// What the room of the incident records

/** A fact the captain or a client added to an incident, kept in the incident's room. */
export const IncidentEventSchema = z.discriminatedUnion("event", [
  /** The captain marked the cause. `client` is the version safe to tell a client. */
  z.object({
    event: z.literal("cause"),
    text: z.string().trim().min(1).max(1000),
    client: z.string().trim().min(1).max(500).optional(),
    at: z.string(),
  }),
  /** A client said it was still broken after Resolved. */
  z.object({ event: z.literal("reopened"), room: TaskIdSchema, at: z.string() }),
  /** An update to a client room: what it was told, and the outbound draft it went as. */
  z.object({
    event: z.literal("told"),
    room: TaskIdSchema,
    status: ClientStatusSchema,
    draft: z.number().int().positive(),
    at: z.string(),
  }),
]);
export type IncidentEvent = z.infer<typeof IncidentEventSchema>;

export const REPORT_SECTIONS = ["summary", "impact", "timeline", "cause", "fix", "followUps"] as const;
export const ReportSectionSchema = z.enum(REPORT_SECTIONS);
export type ReportSection = z.infer<typeof ReportSectionSchema>;

export const REPORT_SECTION_LABEL: Record<ReportSection, string> = {
  summary: "Summary",
  impact: "Impact",
  timeline: "Timeline",
  cause: "Cause",
  fix: "Fix",
  followUps: "Follow-ups",
};

/** One version of the report: a line or two for each section. */
export const ReportTextSchema = z.strictObject({
  summary: z.string().max(2000),
  impact: z.string().max(2000),
  timeline: z.string().max(2000),
  cause: z.string().max(2000),
  fix: z.string().max(2000),
  followUps: z.string().max(2000),
});
export type ReportText = z.infer<typeof ReportTextSchema>;

/** The report as one message to a client: each section under its name. */
export function reportMessage(text: ReportText): string {
  return REPORT_SECTIONS.map((s) => `${REPORT_SECTION_LABEL[s]}\n${text[s].trim()}`).join("\n\n");
}

/** To which rooms the client version went. Once any went, the text is frozen. */
export const ReportSentSchema = z.object({
  room: TaskIdSchema,
  draft: z.number().int().positive(),
  at: z.string(),
});

// ---------------------------------------------------------------------------
// The read model for the task page

export const IncidentRoomViewSchema = z.object({
  room: TaskIdSchema,
  title: z.string(),
  app: ChatAppSchema,
  /** What the room was last told. Absent: nothing yet. */
  sees: ClientStatusSchema.optional(),
  toldAt: z.string().optional(),
  /** How the last update went: `held` waits for the owner. */
  update: z.enum(["held", "sent", "failed", "discarded"]).optional(),
});
export type IncidentRoomView = z.infer<typeof IncidentRoomViewSchema>;

export const IncidentViewSchema = z.object({
  task: TaskIdSchema,
  status: ClientStatusSchema,
  /** The four steps with the time each began; absent when not reached since the last reopen. */
  steps: z.array(z.object({ status: ClientStatusSchema, at: z.string().optional() })),
  /** One line of facts: what the watch says, the fix, the soak. */
  facts: z.string(),
  watch: z.object({ id: z.number().int().positive(), title: z.string(), firing: z.boolean() }).optional(),
  rooms: z.array(IncidentRoomViewSchema),
  report: z
    .object({
      item: z.string(),
      internal: ReportTextSchema,
      client: ReportTextSchema,
      sent: z.array(ReportSentSchema),
    })
    .optional(),
});
export type IncidentView = z.infer<typeof IncidentViewSchema>;

export const IncidentTaskInputSchema = z.object({ task: TaskIdSchema });
export const IncidentCauseInputSchema = z.object({
  task: TaskIdSchema,
  text: z.string().trim().min(1).max(1000),
  /** The same cause in words a client may read: no hosts, no names, no secrets. */
  client: z.string().trim().min(1).max(500).optional(),
});
export const IncidentEditReportInputSchema = z.object({
  task: TaskIdSchema,
  version: z.enum(["internal", "client"]),
  text: ReportTextSchema.partial(),
});
export const IncidentSendReportInputSchema = z.object({ task: TaskIdSchema, room: TaskIdSchema });
