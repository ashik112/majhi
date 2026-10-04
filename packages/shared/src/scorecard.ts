import { z } from "zod";
import { AUTHORITY_ROWS } from "./authority.ts";
import { IdSchema } from "./ids.ts";

/**
 * Outcomes, the scorecard, the trust ladder and the money ceiling (SPEC 5.18, captain v2 step 8).
 * Every output of the captain gets an outcome later; the scorecard reads them; the trust ladder moves
 * an authority row or an outbound channel on them; one monthly ceiling holds new starts.
 */

// ---------------------------------------------------------------------------
// Outcomes

/** What became of an output. `void`: the thing it was about is gone before it could be judged. */
export const OutcomeResultSchema = z.enum([
  "kept",
  "undone",
  "reverted",
  "merged-reverted",
  "task-failed",
  "accepted",
  "dismissed",
  "approved",
  "edited",
  "rejected",
  "overruled",
  "void",
]);
export type OutcomeResult = z.infer<typeof OutcomeResultSchema>;

/** Results that count for the captain. `void` and a missing result count for nothing. */
export const GOOD_OUTCOMES: readonly OutcomeResult[] = ["kept", "accepted", "approved"];
export const BAD_OUTCOMES: readonly OutcomeResult[] = [
  "undone",
  "reverted",
  "merged-reverted",
  "task-failed",
  "dismissed",
  "edited",
  "rejected",
  "overruled",
];
/** The bad results that mean the owner took something back or answered against the captain. */
export const OVERRULE_OUTCOMES: readonly OutcomeResult[] = [
  "undone",
  "reverted",
  "merged-reverted",
  "rejected",
  "overruled",
];

export const OUTCOME_WORD: Record<OutcomeResult, string> = {
  kept: "kept",
  undone: "undone by you",
  reverted: "reverted",
  "merged-reverted": "merged, then reverted",
  "task-failed": "task failed",
  accepted: "accepted",
  dismissed: "dismissed",
  approved: "approved",
  edited: "edited before sending",
  rejected: "rejected",
  overruled: "you chose otherwise",
  void: "gone",
};

/** What an outcome is about. */
export const OutcomeKindSchema = z.enum(["action", "start", "recommendation", "draft", "finding"]);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

/** The authority rows, and `outbound:<channel>` for an outbound channel. */
export const TrustKeySchema = z.string().min(1).max(60);
export type TrustKey = z.infer<typeof TrustKeySchema>;

export function outboundKey(channel: string): string {
  return `outbound:${channel}`;
}
export function isOutboundKey(key: string): boolean {
  return key.startsWith("outbound:");
}
export function isAuthorityKey(key: string): boolean {
  return (AUTHORITY_ROWS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Scorecard

export const ScorecardRangeSchema = z.enum(["today", "week"]);
export type ScorecardRange = z.infer<typeof ScorecardRangeSchema>;

/** The tally of one slice: a workspace, an authority row or a playbook. */
export const TallySchema = z.object({
  /** Everything it did in the range, judged or not. */
  actions: z.number().int().nonnegative(),
  /** Judged: has a result that counts. */
  judged: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
  /** Taken back or answered against: undone, reverted, rejected, overruled. */
  overruled: z.number().int().nonnegative(),
  /** Bad results in all, overruled included. */
  bad: z.number().int().nonnegative(),
  /** Not judged yet. */
  pending: z.number().int().nonnegative(),
  /** Percent of the judged, or absent with nothing judged. */
  keptPct: z.number().min(0).max(100).optional(),
  overruledPct: z.number().min(0).max(100).optional(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Owner minutes saved: kept actions times the minutes of their kind. */
  minutesSaved: z.number().nonnegative(),
});
export type Tally = z.infer<typeof TallySchema>;

export const FindingsTallySchema = z.object({
  filed: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
  /** Accepted out of accepted and dismissed, percent. */
  conversionPct: z.number().min(0).max(100).optional(),
});
export type FindingsTally = z.infer<typeof FindingsTallySchema>;

export const ScorecardOrgSchema = z.object({
  org: IdSchema,
  tally: TallySchema,
  findings: FindingsTallySchema,
  /** The strip's line: "Kept 47/50, $3.10, ~2.5 h saved". Absent with nothing done. */
  line: z.string().optional(),
});
export type ScorecardOrg = z.infer<typeof ScorecardOrgSchema>;

export const ScorecardRowSchema = z.object({
  org: IdSchema,
  /** An authority row id or `outbound:<channel>`. */
  key: TrustKeySchema,
  tally: TallySchema,
  /** The window the trust ladder reads: the last N judged since the last change. */
  window: z.object({ judged: z.number().int().nonnegative(), kept: z.number().int().nonnegative() }),
  /** Where the ladder stands: what it did last, in a sentence. */
  note: z.string().optional(),
});
export type ScorecardRow = z.infer<typeof ScorecardRowSchema>;

export const ScorecardPlaybookSchema = z.object({
  org: IdSchema,
  playbook: z.string(),
  tally: TallySchema,
  findings: FindingsTallySchema,
  muted: z.boolean(),
  runs: z.number().int().nonnegative(),
});
export type ScorecardPlaybook = z.infer<typeof ScorecardPlaybookSchema>;

export const ScorecardSchema = z.object({
  range: ScorecardRangeSchema,
  /** The span it covers, UTC ISO: `from` included, `to` excluded. */
  from: z.string(),
  to: z.string(),
  total: TallySchema,
  orgs: z.array(ScorecardOrgSchema),
  rows: z.array(ScorecardRowSchema),
  playbooks: z.array(ScorecardPlaybookSchema),
  /** Owner minutes per kind of action, as set (defaults where not changed). */
  minutes: z.record(z.string(), z.number().nonnegative()),
  /** How many judged actions the trust ladder reads. */
  window: z.number().int().positive(),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;

export const ScorecardGetInputSchema = z.object({
  range: ScorecardRangeSchema.default("week"),
  org: IdSchema.optional(),
});

/** Default owner minutes saved per kept action. The owner edits them. */
export const DEFAULT_MINUTES: Record<string, number> = {
  start: 10,
  questions: 3,
  approvals: 1,
  upkeep: 2,
  merge: 5,
  push: 3,
  own: 1,
  draft: 8,
  finding: 15,
};
/** What a minutes setting is named in words. */
export const MINUTES_LABEL: Record<string, string> = {
  start: "Start work",
  questions: "Answer a question",
  approvals: "Approve a card",
  upkeep: "Upkeep step",
  merge: "Merge",
  push: "Push",
  own: "Own work approval",
  draft: "Approved draft",
  finding: "Finding that became a fix",
};
export const MINUTES_KINDS = Object.keys(DEFAULT_MINUTES);

export const ScorecardSetMinutesInputSchema = z.object({
  kind: z.string().refine((k) => MINUTES_KINDS.includes(k), "That is not a kind of action"),
  /** Absent: back to the default. */
  minutes: z.number().min(0).max(600).optional(),
});

/** "Kept 47/50, $3.10, ~2.5 h saved". */
export function scorecardLine(t: Pick<Tally, "judged" | "kept" | "costUsd" | "minutesSaved">): string | undefined {
  if (t.judged === 0 && t.costUsd === 0 && t.minutesSaved === 0) return undefined;
  const parts = [`Kept ${t.kept}/${t.judged}`, moneyWord(t.costUsd)];
  if (t.minutesSaved > 0) parts.push(`~${hoursWord(t.minutesSaved)} saved`);
  return parts.join(", ");
}

export function moneyWord(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd).toLocaleString("en-US")}` : `$${usd.toFixed(2)}`;
}

/** Minutes as "45 min" or "2.5 h". */
export function hoursWord(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h} h`;
}

// ---------------------------------------------------------------------------
// Trust ladder

export const TRUST_KINDS = ["demoted", "promote", "muted"] as const;
export const TrustNoticeKindSchema = z.enum(TRUST_KINDS);
export type TrustNoticeKind = z.infer<typeof TrustNoticeKindSchema>;

/** The thresholds of the ladder. Not settings: the spec's numbers. */
export const TRUST_DEMOTE_BELOW = 80;
export const TRUST_PROMOTE_ABOVE = 95;
export const TRUST_MUTE_ABOVE = 70;
export const TRUST_QUIET_DAYS = 7;
export const TRUST_SNOOZE_DAYS = 14;
export const TRUST_WINDOW_DEFAULT = 20;

export const TrustStateSchema = z.object({
  org: IdSchema,
  key: TrustKeySchema,
  /** `decide` or `ask` for an authority row; Draft, Batch or Auto for a channel. */
  now: z.string(),
  /** Outcomes before this moment no longer count (the last change). */
  since: z.string().optional(),
  /** A promotion proposal waits until this moment. */
  snoozedUntil: z.string().optional(),
  window: z.object({ judged: z.number().int().nonnegative(), kept: z.number().int().nonnegative() }),
});
export type TrustState = z.infer<typeof TrustStateSchema>;

export const TrustListSchema = z.object({
  window: z.number().int().positive(),
  states: z.array(TrustStateSchema),
  muted: z.array(z.object({ org: IdSchema, playbook: z.string(), at: z.string() })),
});
export type TrustList = z.infer<typeof TrustListSchema>;

export const TrustUnmuteInputSchema = z.object({ org: IdSchema, playbook: IdSchema });

export function trustDecisionId(id: number): string {
  return `trust:${id}`;
}
export function ceilingDecisionId(month: string): string {
  return `ceiling:${month}`;
}

// ---------------------------------------------------------------------------
// Money

export const MoneyRatesSchema = z.object({
  /** What the client pays per month, in dollars. */
  retainerUsd: z.number().min(0).max(10_000_000).optional(),
  /** What an hour of the owner's time is worth for this client, in dollars. */
  hourlyUsd: z.number().min(0).max(100_000).optional(),
});
export type MoneyRates = z.infer<typeof MoneyRatesSchema>;

export const MoneyOrgSchema = z.object({
  org: IdSchema,
  spentUsd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
  minutesSaved: z.number().nonnegative(),
  rates: MoneyRatesSchema,
  /** Value of the time saved at the hourly rate. Absent without a rate. */
  savedUsd: z.number().nonnegative().optional(),
  /** Retainer minus spend. Absent without a retainer. */
  marginUsd: z.number().optional(),
});
export type MoneyOrg = z.infer<typeof MoneyOrgSchema>;

export const MoneyStatusSchema = z.object({
  /** `YYYY-MM` in the owner's time zone. */
  month: z.string(),
  from: z.string(),
  to: z.string(),
  spentUsd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
  /** The monthly ceiling as it holds now (a raise for this month counts). Absent: none set. */
  ceilingUsd: z.number().positive().optional(),
  /** The ceiling the owner saved, before a raise for this month. */
  savedCeilingUsd: z.number().positive().optional(),
  /** At the pace so far, where the month ends. Absent in the first hours of the month. */
  projectedUsd: z.number().nonnegative().optional(),
  /** The ceiling is reached: new starts are held. */
  held: z.boolean(),
  /** One line for the Captain header: "$212 of $500 this month, on pace for $410". */
  line: z.string(),
  orgs: z.array(MoneyOrgSchema),
  /** Where the spend came from. */
  parts: z.object({
    agents: z.number().nonnegative(),
    captain: z.number().nonnegative(),
  }),
});
export type MoneyStatus = z.infer<typeof MoneyStatusSchema>;

export const MoneySetInputSchema = z.object({
  /** The monthly ceiling in dollars; `null` clears it. */
  ceilingUsd: z.number().positive().max(10_000_000).nullable().optional(),
  /** A workspace's rates; `null` for a field clears it. */
  rates: z
    .object({
      org: IdSchema,
      retainerUsd: z.number().min(0).max(10_000_000).nullable().optional(),
      hourlyUsd: z.number().min(0).max(100_000).nullable().optional(),
    })
    .optional(),
});
export type MoneySetInput = z.infer<typeof MoneySetInputSchema>;
