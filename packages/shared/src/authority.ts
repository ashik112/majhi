import { z } from "zod";

/**
 * Who decides, per workspace (SPEC 5.18): six rows, each `decide` (the captain does it while
 * Autonomous is On) or `ask` (it waits for the owner).
 */
export const AuthorityChoiceSchema = z.enum(["decide", "ask"]);
export type AuthorityChoice = z.infer<typeof AuthorityChoiceSchema>;

export const AUTHORITY_ROWS = ["start", "questions", "approvals", "upkeep", "merge", "push"] as const;
export const AuthorityRowSchema = z.enum(AUTHORITY_ROWS);
export type AuthorityRow = z.infer<typeof AuthorityRowSchema>;

export const AuthoritySchema = z.strictObject({
  /** Pick and start work from the backlog. */
  start: AuthorityChoiceSchema,
  /** Answer agents' questions. */
  questions: AuthorityChoiceSchema,
  /** Answer routine approval cards. */
  approvals: AuthorityChoiceSchema,
  /** Memory, projects, triage, cleanup, stuck tasks. */
  upkeep: AuthorityChoiceSchema,
  /** Merge into the base branch (shipping). */
  merge: AuthorityChoiceSchema,
  /** Push and open merge requests. */
  push: AuthorityChoiceSchema,
});
export type Authority = z.infer<typeof AuthoritySchema>;

/** The row names in plain words, for the table. */
export const AUTHORITY_LABEL: Record<AuthorityRow, string> = {
  start: "Start work from the backlog",
  questions: "Answer agents' questions",
  approvals: "Answer routine approval cards",
  upkeep: "Upkeep: memory, projects, triage, cleanup",
  merge: "Merge into the base branch",
  push: "Push and open merge requests",
};

/** What finishes "Refused: in Acme you decide ...". */
export const AUTHORITY_REFUSAL: Record<AuthorityRow, string> = {
  start: "when work starts, so the captain does not start it",
  questions: "how agents' questions are answered, so the captain does not answer them",
  approvals: "routine approval cards, so the captain does not answer them",
  upkeep: "the upkeep, so the captain does not do it",
  merge: "when work is merged, so the captain does not merge it",
  push: "when work is pushed, so the captain does not push it",
};

export const ALL_ASK: Authority = {
  start: "ask",
  questions: "ask",
  approvals: "ask",
  upkeep: "ask",
  merge: "ask",
  push: "ask",
};
