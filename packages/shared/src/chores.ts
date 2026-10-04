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
