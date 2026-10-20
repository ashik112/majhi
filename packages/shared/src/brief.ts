import { z } from "zod";

/**
 * The morning brief (docs/briefs/captain.md): one short brief per workspace and day, made in code from what the
 * captain and Autonomous did, worded by the smallest model when there is one. Where it shows: a Done item in
 * Needs you and the newest line of the Captain conversation. One combined push a morning goes to the owner's alert
 * channels, outside the incident ping rules.
 */

/** A calendar day, `2026-11-20`. */
export const IsoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-20");

export const MorningBriefSourceSchema = z.enum(["model", "template"]);
export type MorningBriefSource = z.infer<typeof MorningBriefSourceSchema>;

/** The facts of one workspace's brief. Code gathers them; the model, when there is one, only words them. */
export const BriefFactsSchema = z.object({
  org: z.string().min(1),
  orgName: z.string().min(1),
  day: IsoDaySchema,
  /** The span the numbers cover (UTC). */
  from: z.string(),
  to: z.string(),
  /** Tasks Autonomous took on in the span. */
  took: z.number().int().min(0),
  shipped: z.number().int().min(0),
  shippedTitles: z.array(z.string()).max(3),
  merged: z.number().int().min(0),
  failed: z.number().int().min(0),
  spent: z.number().min(0),
  /** The workspace's day budget in dollars, else the Autonomous one, when one is set. */
  budget: z.number().min(0).optional(),
  findingsNew: z.number().int().min(0),
  findingsFixed: z.number().int().min(0),
  /** What the captain did by itself, in counts: decisions it answered and chores it ran. */
  captainDecided: z.number().int().min(0),
  captainUpkeep: z.number().int().min(0),
  needs: z.object({
    count: z.number().int().min(0),
    top: z.array(z.string()).max(3),
  }),
  next: z.array(z.string()).max(3),
  /** Nothing waits for the owner in this workspace. */
  empty: z.boolean(),
});
export type BriefFacts = z.infer<typeof BriefFactsSchema>;

export const BRIEF_MAX_LINES = 6;
export const BRIEF_LINE_MAX = 180;

export const BriefSchema = z.object({
  org: z.string().min(1),
  day: IsoDaySchema,
  /** When it was made (ISO). */
  at: z.string(),
  lines: z.array(z.string().min(1).max(BRIEF_LINE_MAX)).min(1).max(BRIEF_MAX_LINES),
  source: MorningBriefSourceSchema,
  facts: BriefFactsSchema,
  /** Nothing happened and nothing waits: stored so it is not made again, never shown. */
  quiet: z.boolean(),
});
export type Brief = z.infer<typeof BriefSchema>;

export const BriefListInputSchema = z.object({
  /** Only this workspace's. */
  org: z.string().min(1).max(63).optional(),
});
export type BriefListInput = z.infer<typeof BriefListInputSchema>;
