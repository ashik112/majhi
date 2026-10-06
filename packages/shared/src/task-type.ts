import { z } from "zod";
import type { BranchType } from "./accounts.ts";
import type { FindingSeverity, FindingSource } from "./findings.ts";

/**
 * What a task is, as opposed to `kind` (how it runs). A type is stored once, on the task, with who
 * set it. Everything else that depends on it, like the branch type, is derived from it on read.
 */

export const TASK_TYPES = [
  "bug",
  "incident",
  "feature",
  "request",
  "research",
  "design",
  "test",
  "chore",
] as const;
export const TaskTypeSchema = z.enum(TASK_TYPES);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  bug: "Bug",
  incident: "Incident",
  feature: "Feature",
  request: "Request",
  research: "Research",
  design: "Design",
  test: "Test",
  chore: "Chore",
};

/** Who set a type: the owner, the captain, or majhi's own reading of the text and source at intake. */
export const TypeBySchema = z.enum(["owner", "captain", "intake"]);
export type TypeBy = z.infer<typeof TypeBySchema>;

/**
 * A task's type and who set it. A task has both or neither: an untyped task (every task made before
 * types existed) has no `typing`, so a type without an author cannot be written.
 */
export const TaskTypingSchema = z.object({ type: TaskTypeSchema, by: TypeBySchema });
export type TaskTyping = z.infer<typeof TaskTypingSchema>;

/** Who wins: the owner over the captain over intake. */
const AUTHORITY: Record<TypeBy, number> = { intake: 0, captain: 1, owner: 2 };

/**
 * Whether `by` may replace the current typing. The owner's choice is never overwritten by the
 * captain or by inference; the captain's is never overwritten by inference. An untyped task takes
 * anyone's.
 */
export function mayRetype(current: TaskTyping | undefined, by: TypeBy): boolean {
  return current === undefined || AUTHORITY[by] >= AUTHORITY[current.by];
}

/** The branch type a task type starts its branch with: the one source for it, so a task never has two guesses. */
export const BRANCH_TYPE_OF: Record<TaskType, BranchType> = {
  bug: "fix",
  incident: "fix",
  feature: "feat",
  request: "feat",
  research: "chore",
  design: "feat",
  test: "test",
  chore: "chore",
};

/** The task type a branch type suggests, for a title that reads like one. */
export const TASK_TYPE_OF_BRANCH: Record<BranchType, TaskType> = {
  feat: "feature",
  fix: "bug",
  chore: "chore",
  docs: "chore",
  refactor: "chore",
  test: "test",
  perf: "chore",
  ci: "chore",
  build: "chore",
};

/** What a finding of a source is, and what it becomes at high severity. Absent: the source says nothing. */
const FINDING_TYPE: Record<FindingSource, { type: TaskType; high?: TaskType } | undefined> = {
  "follow-up": undefined,
  security: { type: "bug" },
  dependency: { type: "chore" },
  ci: { type: "bug" },
  log: { type: "bug", high: "incident" },
  ui: { type: "bug" },
  radar: { type: "research" },
  opportunity: undefined,
  setup: { type: "chore" },
  incident: { type: "incident" },
  competitor: { type: "research" },
  grant: undefined,
  launch: undefined,
  deal: undefined,
  social: undefined,
  inbox: { type: "request" },
  analysis: { type: "research" },
  legal: { type: "research" },
  other: undefined,
};

/** The first guess for a task made from a finding, or undefined when its source does not say. */
export function findingTaskType(source: FindingSource, severity: FindingSeverity): TaskType | undefined {
  const row = FINDING_TYPE[source];
  return row === undefined ? undefined : severity === "high" ? (row.high ?? row.type) : row.type;
}
