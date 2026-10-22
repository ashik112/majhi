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
  "support",
  "post",
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
  support: "Support",
  post: "Post",
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
  support: "chore",
  post: "chore",
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
  client: { type: "request" },
  analysis: { type: "research" },
  legal: { type: "research" },
  other: undefined,
};

/** The first guess for a task made from a finding, or undefined when its source does not say. */
export function findingTaskType(source: FindingSource, severity: FindingSeverity): TaskType | undefined {
  const row = FINDING_TYPE[source];
  return row === undefined ? undefined : severity === "high" ? (row.high ?? row.type) : row.type;
}

/**
 * What a kind of task holds beyond the common fields, in one object on the task, discriminated by its
 * type. Only a post has any today: its draft, the channel it goes to and when. A kind with nothing to
 * hold has no member. `fieldsFit` is the one check that the object belongs to the task's own type.
 */
export const PostFieldsSchema = z.object({
  type: z.literal("post"),
  /** The text to publish. */
  draft: z.string().max(10_000),
  /** Where it goes, in the owner's words ("LinkedIn, Acme page"). */
  channel: z.string().trim().min(1).max(120),
  /** When it goes out, as written ("Tue 14 Oct 10:00"). Absent: when approved. */
  schedule: z.string().trim().min(1).max(120).optional(),
  /**
   * When the owner approved it. Set once; a post with it asks nothing more. No real channel is connected
   * yet, so this is the record that it was approved to go out.
   */
  approvedAt: z.string().optional(),
});
export type PostFields = z.infer<typeof PostFieldsSchema>;

// ---------------------------------------------------------------------------
// A case: an incident a client reported, worked by the captain (docs/briefs/case-flow.md)

/** What the captain may spend on one case before it stops and writes one card for the owner. */
export const CASE_MAX_CALLS = 20;
export const CASE_MAX_MS = 30 * 60_000;
/** Messages the captain may send the client about one open case; the closing message is on top of them. */
export const CASE_MAX_TOLD = 2;

/** One command the captain ran on a connected host: its key, when, and a hash of what it answered. */
export const CaseCommandSchema = z.object({
  /** The connection and the command line. */
  key: z.string().max(600),
  at: z.string(),
  /** How many changes the case had made when it ran: the same command runs again only after another one. */
  change: z.number().int().min(0),
  /** A hash of the output. */
  result: z.string().max(64),
  ok: z.boolean(),
});
export type CaseCommand = z.infer<typeof CaseCommandSchema>;

/** Something worth doing later that the case found. It becomes a task only when the owner presses Make it a task. */
export const CaseFollowUpSchema = z.object({
  id: z.string().min(1).max(12),
  text: z.string().trim().min(1).max(300),
  at: z.string(),
  /** The task the owner made of it. */
  task: z.string().max(40).optional(),
});
export type CaseFollowUp = z.infer<typeof CaseFollowUpSchema>;

/** A read that exited 0 after the last change: what the case rests "fixed" on. */
export const CaseCheckSchema = z.object({
  at: z.string(),
  /** How many changes the case had made when the read ran. */
  change: z.number().int().min(0),
  what: z.string().max(300),
});

export const CaseRecordSchema = z.object({
  /** The client chat that reported it. */
  room: z.string().min(1).max(100),
  /** Who reported it, for the line in Work. */
  client: z.string().max(100),
  /** When it opened. */
  openedAt: z.string(),
  /** The day it opened, `YYYY-MM-DD` in the workspace's time zone. Only a case of today takes a new report. */
  day: z.string().max(10),
  /** What the client said, as data. */
  symptom: z.string().max(600),
  /** Tool calls the captain made for it, and its time on it in milliseconds. */
  calls: z.number().int().min(0),
  ms: z.number().min(0),
  commands: z.array(CaseCommandSchema).max(100),
  /** The recoveries done, by action: each runs once per case. */
  recoveries: z.array(z.string().max(500)).max(20),
  /** How many recoveries and writes ran in the case. Reads and checks are counted against it. */
  changes: z.number().int().min(0),
  checks: z.array(CaseCheckSchema).max(30),
  /** Messages told to the client about it. */
  told: z.number().int().min(0),
  followUps: z.array(CaseFollowUpSchema).max(10),
  /** It ran out of calls or time, or the captain gave up: the one card says what it needs. */
  stopped: z.object({ at: z.string(), why: z.string().max(300) }).optional(),
  /** Three to six lines, written when the case closes: the one thing the owner reads in the morning. */
  summary: z.string().max(1200).optional(),
  closedAt: z.string().optional(),
});
export type CaseRecord = z.infer<typeof CaseRecordSchema>;

/** The fields of an incident task a client reported. An incident without them is a watch's or a deploy's. */
export const IncidentFieldsSchema = z.object({ type: z.literal("incident"), case: CaseRecordSchema });
export type IncidentFields = z.infer<typeof IncidentFieldsSchema>;

export const TaskFieldsSchema = z.discriminatedUnion("type", [PostFieldsSchema, IncidentFieldsSchema]);
export type TaskFields = z.infer<typeof TaskFieldsSchema>;

/** The case a task holds, or undefined when it is not one. */
export function caseOf(task: { fields?: TaskFields | undefined }): CaseRecord | undefined {
  return task.fields?.type === "incident" ? task.fields.case : undefined;
}

/** The view of a case a task list row carries. */
export function caseViewOf(record: CaseRecord): CaseView {
  return {
    room: record.room,
    client: record.client,
    symptom: record.symptom,
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    followUps: record.followUps,
    stopped: record.stopped !== undefined,
    openedAt: record.openedAt,
  };
}

/** What a case shows in the task list: enough for its line in Work and its summary in Done today. */
export const CaseViewSchema = z.object({
  room: z.string(),
  client: z.string(),
  symptom: z.string(),
  summary: z.string().optional(),
  followUps: z.array(CaseFollowUpSchema),
  stopped: z.boolean(),
  openedAt: z.string(),
});
export type CaseView = z.infer<typeof CaseViewSchema>;

/** Whether `fields` belong to a task of this type: a post's fields on a bug are refused. */
export function fieldsFit(typing: TaskTyping | undefined, fields: TaskFields): boolean {
  return typing?.type === fields.type;
}

/**
 * What a caller may write: the fields without the owner's approval. `approvedAt` is set only by the
 * owner's answer to the publish decision, never by a command that writes the draft.
 */
export const TaskFieldsInputSchema = z.discriminatedUnion("type", [
  PostFieldsSchema.omit({ approvedAt: true }),
]);
export type TaskFieldsInput = z.infer<typeof TaskFieldsInputSchema>;
