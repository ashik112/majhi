import { z } from "zod";

/** The upkeep chores (the table in 5.18). Its own file so settings can name them without a cycle. */
export const CaptainChoreSchema = z.enum([
  "ship",
  "cards",
  "questions",
  "memory",
  "projects",
  "triage",
  "cleanup",
  "stuck",
  "followups",
  "discover",
  "tidy",
  "health",
  "checklist",
]);
export type CaptainChore = z.infer<typeof CaptainChoreSchema>;

/** One daily cap the owner set: a number, or `null` for no cap. Absent: majhi's default. */
const CapValue = z.number().int().min(1).max(100_000).nullable();

/** The owner's daily caps for a chore in one workspace (Limits). */
export const ChoreCapSchema = z.strictObject({
  actions: CapValue.optional(),
  runs: CapValue.optional(),
});
export type ChoreCap = z.infer<typeof ChoreCapSchema>;

export const ChoreCapsSchema = z.partialRecord(CaptainChoreSchema, ChoreCapSchema);
export type ChoreCaps = z.infer<typeof ChoreCapsSchema>;

/**
 * majhi's daily caps per chore and workspace when the owner set none: `actions` counts what it did or
 * handed to the owner, `runs` counts runs. Ship has none where the captain decides merges.
 */
export const DAILY_CHORE_CAPS: Record<CaptainChore, { actions?: number; runs?: number }> = {
  ship: { actions: 40 },
  cards: { actions: 40 },
  questions: { actions: 20 },
  memory: { runs: 4 },
  projects: { runs: 3, actions: 10 },
  triage: { runs: 1, actions: 20 },
  cleanup: { runs: 1, actions: 20 },
  stuck: { actions: 10 },
  followups: { runs: 1, actions: 25 },
  discover: { runs: 1, actions: 6 },
  tidy: { runs: 1, actions: 25 },
  health: { runs: 2, actions: 15 },
  checklist: { runs: 1, actions: 20 },
};
