import { z } from "zod";

/**
 * Who decides, per workspace (SPEC 5.18): ten rows, each `decide` (the captain does it while
 * Autonomous is On) or `ask` (it waits for the owner). Merge, the two Deploy rows and Tell can be
 * refined per task type (`ship-rules.ts`); the row is what applies when no rule matches.
 */
export const AuthorityChoiceSchema = z.enum(["decide", "ask"]);
export type AuthorityChoice = z.infer<typeof AuthorityChoiceSchema>;

export const AUTHORITY_ROWS = [
  "start",
  "questions",
  "approvals",
  "upkeep",
  "merge",
  "push",
  "deployStaging",
  "deployProduction",
  "tell",
  "own",
] as const;
export const AuthorityRowSchema = z.enum(AUTHORITY_ROWS);
export type AuthorityRow = z.infer<typeof AuthorityRowSchema>;

export const AuthoritySchema = z.strictObject({
  /** Pick and start work from the backlog. */
  start: AuthorityChoiceSchema,
  /** Answer agents' questions. */
  questions: AuthorityChoiceSchema,
  /** Answer routine approval cards. */
  approvals: AuthorityChoiceSchema,
  /** Memory, projects, triage, cleanup, follow-ups. */
  upkeep: AuthorityChoiceSchema,
  /** Merge into the base branch, or merge the open merge request on the host (shipping). */
  merge: AuthorityChoiceSchema,
  /** Push and open merge requests. */
  push: AuthorityChoiceSchema,
  /** Deploy to staging after a merge. Absent in settings saved before this row: You. */
  deployStaging: AuthorityChoiceSchema.default("ask"),
  /** Deploy to production. Absent in settings saved before this row: You. */
  deployProduction: AuthorityChoiceSchema.default("ask"),
  /** Send the reply to the client. Absent in settings saved before this row: You. */
  tell: AuthorityChoiceSchema.default("ask"),
  /**
   * Own work: the captain approves the routine permission requests of tasks it started itself, inside
   * the task's scope. Absent in settings saved before this row: You.
   */
  own: AuthorityChoiceSchema.default("ask"),
});
export type Authority = z.infer<typeof AuthoritySchema>;

/**
 * A change to some rows of a workspace's authority. Unlike `AuthoritySchema` it fills in nothing: a row
 * that is not named keeps its saved value. (A `.partial()` of `AuthoritySchema` would apply the rows'
 * defaults and quietly reset Deploy staging, Deploy production, Tell and Own to You on every change.)
 */
export const AuthorityPatchSchema = z.strictObject(
  Object.fromEntries(AUTHORITY_ROWS.map((row) => [row, AuthorityChoiceSchema.optional()])) as {
    [K in AuthorityRow]: z.ZodOptional<typeof AuthorityChoiceSchema>;
  },
);
export type AuthorityPatch = z.infer<typeof AuthorityPatchSchema>;

/** The row names in plain words, for the table. */
export const AUTHORITY_LABEL: Record<AuthorityRow, string> = {
  start: "Start work from the backlog",
  questions: "Answer agents' questions",
  approvals: "Answer routine approval cards",
  upkeep: "Upkeep: memory, projects, triage, cleanup",
  merge: "Merge into the base branch, or the merge request on its host",
  push: "Push and open merge requests",
  deployStaging: "Deploy to staging",
  deployProduction: "Deploy to production",
  tell: "Tell the client",
  own: "Own work: approve routine requests of tasks it started",
};

/** Each row as a short verb phrase, for one-line titles ("captain decides merge, push"). */
export const AUTHORITY_SHORT: Record<AuthorityRow, string> = {
  start: "start work",
  questions: "answer questions",
  approvals: "answer approvals",
  upkeep: "upkeep",
  merge: "merge",
  push: "push",
  deployStaging: "deploy staging",
  deployProduction: "deploy production",
  tell: "tell the client",
  own: "own work",
};

/** What finishes "Refused: in Acme you decide ...". */
export const AUTHORITY_REFUSAL: Record<AuthorityRow, string> = {
  start: "when work starts, so the captain does not start it",
  questions: "how agents' questions are answered, so the captain does not answer them",
  approvals: "routine approval cards, so the captain does not answer them",
  upkeep: "the upkeep, so the captain does not do it",
  merge: "when work is merged, so the captain does not merge it",
  push: "when work is pushed, so the captain does not push it",
  deployStaging: "when work is deployed to staging, so the captain does not deploy it",
  deployProduction: "when work is deployed to production, so the captain does not deploy it",
  tell: "what the client is told, so the captain does not tell them",
  own: "the routine requests of work the captain started, so the captain does not approve them",
};

/** One plain line under the Own work row: what Captain means there, and what it never covers. */
export const OWN_WORK_LINE =
  "Approves routine requests of tasks it started: reads, edits in the task's folder, running the project's tests, build and lint, installing its declared packages. Never secrets, pushes, deletes or new network hosts.";

export const ALL_ASK: Authority = {
  start: "ask",
  questions: "ask",
  approvals: "ask",
  upkeep: "ask",
  merge: "ask",
  push: "ask",
  deployStaging: "ask",
  deployProduction: "ask",
  tell: "ask",
  own: "ask",
};

/**
 * The rows full access leaves to their own switch: the owner may give the captain everything else and
 * still merge, or push, themselves.
 */
export const FULL_ACCESS_KEEPS: readonly AuthorityRow[] = ["merge", "push"];

/**
 * The rows full access never grants: what leaves the machine for a server or a client. They are
 * the owner's own choice, "You" until the owner sets them, so full access cannot deploy or talk by itself.
 */
export const FULL_ACCESS_NEVER: readonly AuthorityRow[] = ["deployStaging", "deployProduction", "tell"];
