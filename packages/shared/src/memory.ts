import { z } from "zod";
import { IdSchema } from "./accounts.ts";
import { TaskIdSchema } from "./tasks.ts";

/**
 * majhi memory (SPEC 5.6): short facts with a scope and provenance, kept in `~/.majhi/memory/memory.db`.
 * Agents only propose; the owner, or curation with the owner's rules, makes a fact active.
 */

/** `global`, `org:<org>` or `project:<project>`. */
export const MemoryScopeSchema = z
  .string()
  .trim()
  .max(100)
  .refine((s) => parseScope(s) !== undefined, "Use global, org:<id> or project:<id>");
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const GLOBAL_SCOPE = "global";
export const orgScope = (org: string): MemoryScope => `org:${org}`;
export const projectScope = (project: string): MemoryScope => `project:${project}`;

export type ParsedScope = { kind: "global" } | { kind: "org" | "project"; id: string };

export function parseScope(scope: string): ParsedScope | undefined {
  if (scope === GLOBAL_SCOPE) return { kind: "global" };
  const match = /^(org|project):(.+)$/.exec(scope);
  if (match === null) return undefined;
  const [, kind, id] = match;
  if (kind === undefined || id === undefined || !IdSchema.safeParse(id).success) return undefined;
  return { kind: kind === "org" ? "org" : "project", id };
}

/** `pending` waits for a decision; `rejected` was dropped and can be undone; `retired` stopped being true. */
export const FactStatusSchema = z.enum(["pending", "active", "retired", "rejected"]);
export type FactStatus = z.infer<typeof FactStatusSchema>;

export const FactIdSchema = z.number().int().positive();
export type FactId = z.infer<typeof FactIdSchema>;

/** A fact is one or two sentences. */
export const MAX_FACT_CHARS = 500;
export const FactTextSchema = z.string().trim().min(3).max(MAX_FACT_CHARS);

/** What recall puts in TASK.md and returns to an agent: about 500 tokens at 4 characters each. */
export const RECALL_TOKENS = 500;
export const CHARS_PER_TOKEN = 4;

export const FactSchema = z.object({
  id: FactIdSchema,
  text: z.string(),
  scope: MemoryScopeSchema,
  /** The task it was learned in. */
  task: TaskIdSchema.optional(),
  /** The agent that proposed it, `owner` when the owner added it. */
  agent: z.string().optional(),
  status: FactStatusSchema,
  pinned: z.boolean(),
  /** The task that adds it to the repo's AGENTS.md. */
  promoted: TaskIdSchema.optional(),
  use_count: z.number().int().min(0),
  created_at: z.string(),
  valid_from: z.string().optional(),
  /** Set when it is retired. */
  valid_to: z.string().optional(),
  duplicate_of: FactIdSchema.optional(),
  /** Who made it active or rejected it: `owner`, or the curation provider. */
  decided_by: z.string().optional(),
});
export type Fact = z.infer<typeof FactSchema>;

export const MemoryActionSchema = z.enum([
  "proposed",
  "added",
  "approved",
  "rejected",
  "retired",
  "restored",
  "pinned",
  "unpinned",
  "duplicate",
  "promoted",
  "unpromoted",
]);
export type MemoryAction = z.infer<typeof MemoryActionSchema>;

export const MemoryEventSchema = z.object({
  id: z.number().int().positive(),
  fact: FactIdSchema,
  action: MemoryActionSchema,
  /** `owner`, `agent:<id>` or `curation`. */
  actor: z.string(),
  task: TaskIdSchema.optional(),
  reason: z.string().optional(),
  /** What the fact was before the step, so undo can put it back. Absent when the step changed no fact. */
  from: FactStatusSchema.optional(),
  /** 0 to 1, for a step curation took by itself. */
  confidence: z.number().min(0).max(1).optional(),
  provider: z.string().optional(),
  at: z.string(),
  undone: z.boolean(),
});
export type MemoryEvent = z.infer<typeof MemoryEventSchema>;

export const FactHitSchema = z.object({
  fact: FactSchema,
  /** Reciprocal rank fusion score. Higher is better. */
  score: z.number(),
});
export type FactHit = z.infer<typeof FactHitSchema>;

// ---------------------------------------------------------------------------
// Commands (5.16)

export const MemorySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  /** Default: every scope. */
  scopes: z.array(MemoryScopeSchema).max(50).optional(),
  status: FactStatusSchema.default("active"),
  limit: z.number().int().min(1).max(100).default(20),
});

export const MemoryListInputSchema = z.object({
  scope: MemoryScopeSchema.optional(),
  status: FactStatusSchema.optional(),
  /** Facts learned in this task. */
  task: TaskIdSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});

export const MemoryAddInputSchema = z.object({
  text: FactTextSchema,
  scope: MemoryScopeSchema,
  pinned: z.boolean().default(false),
});

export const MemoryDecideInputSchema = z.object({
  id: FactIdSchema,
  reason: z.string().trim().max(500).optional(),
});

export const MemoryUndoInputSchema = z.object({
  event: z.number().int().positive(),
});

export const MemoryExtractInputSchema = z.object({
  task: TaskIdSchema,
});

export const MemoryExtractOutputSchema = z.object({
  /** Candidates the Housekeeper wrote. */
  candidates: z.number().int().min(0),
  /** Kept pending for the owner, kept or dropped on their own, dropped as duplicates, rejected by the rules. */
  pending: z.number().int().min(0),
  kept: z.number().int().min(0),
  dropped: z.number().int().min(0),
  duplicates: z.number().int().min(0),
  rejected: z.number().int().min(0),
  /** Lessons left out because the repo's CLAUDE.md, AGENTS.md or README already says them. */
  in_docs: z.number().int().min(0).default(0),
  /** The task record was written (or written again). */
  record: z.boolean().default(false),
  /** Open threads added, and older ones this task closed. */
  threads_opened: z.number().int().min(0).default(0),
  threads_closed: z.number().int().min(0).default(0),
  /** Projects whose brief got a new version. */
  briefs: z.array(IdSchema).default([]),
});
export type MemoryExtractOutput = z.infer<typeof MemoryExtractOutputSchema>;

export const MemoryPromoteInputSchema = z.object({
  id: FactIdSchema,
});

export const MemoryPromoteOutputSchema = z.object({
  fact: FactSchema,
  /** The task that adds the fact to AGENTS.md. It waits in review. */
  task: TaskIdSchema,
});

export const MemoryPinInputSchema = z.object({
  id: FactIdSchema,
  pinned: z.boolean().default(true),
});

export const MemoryEventsInputSchema = z.object({
  task: TaskIdSchema.optional(),
  fact: FactIdSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});

// ---------------------------------------------------------------------------
// `majhi-memory` MCP tools (agents only see global, their task's org and that org's projects)

export const MemoryRecallToolSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("What you want to know, in a sentence or a few keywords"),
  scope: MemoryScopeSchema.optional().describe("One scope to search. Default: all you may see"),
});

export const MemoryProposeToolSchema = z.object({
  text: FactTextSchema.describe(
    "One short fact that will still hold in later tasks: a convention, a command, a decision. Not task chatter. Never a secret or personal data",
  ),
  scope: MemoryScopeSchema.optional().describe(
    "global, org:<id> or project:<id>. Default: your task's org. It stays pending until it is approved",
  ),
});

export const MemoryListRecentToolSchema = z.object({
  scope: MemoryScopeSchema.optional().describe("One scope to list. Default: all you may see"),
  limit: z.number().int().min(1).max(50).default(10),
});

export const MemoryRecordsToolSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("What you want to know about past tasks: an area, a file, a feature, a problem"),
  project: IdSchema.optional().describe("One project to search. Default: all you may see"),
});

export const MemoryBriefToolSchema = z.object({
  project: IdSchema.describe("The project id, as in TASK.md's Repos"),
});

export const MemoryThreadsToolSchema = z.object({
  project: IdSchema.optional().describe("One project. Default: all you may see"),
});

// ---------------------------------------------------------------------------
// Task records, project briefs and open threads

/** The sections of a task record, in order. */
export const RECORD_SECTIONS = ["asked", "done", "decisions", "outcome", "left"] as const;
export type RecordSection = (typeof RECORD_SECTIONS)[number];
export const RECORD_SECTION_TITLES: Record<RecordSection, string> = {
  asked: "Asked",
  done: "Done",
  decisions: "Decisions",
  outcome: "Outcome",
  left: "Left",
};

/** Where one repo of a finished task landed, read from git by the server. */
export const RecordRepoSchema = z.object({
  project: IdSchema,
  branch: z.string(),
  base: z.string(),
  /** The branch is in its base (merged here, or its merge request merged). */
  merged: z.boolean(),
  /** The branch tip, short hash. */
  head: z.string().optional(),
  commits: z.number().int().min(0),
  mr: z.string().optional(),
});
export type RecordRepo = z.infer<typeof RecordRepoSchema>;

/**
 * What a finished task did, in plain prose with short sections. The Housekeeper writes it once when
 * the task is done. It is kept without approval: it is a record of what happened, not advice.
 */
export const TaskRecordSchema = z.object({
  id: z.number().int().positive(),
  task: TaskIdSchema,
  title: z.string(),
  org: IdSchema.optional(),
  projects: z.array(IdSchema),
  asked: z.string(),
  done: z.string(),
  decisions: z.string(),
  outcome: z.string(),
  left: z.string(),
  repos: z.array(RecordRepoSchema),
  /** The Housekeeper that wrote it. */
  agent: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const TaskRecordHitSchema = z.object({ record: TaskRecordSchema, score: z.number() });
export type TaskRecordHit = z.infer<typeof TaskRecordHitSchema>;

/** The sections of a project brief, in order. */
export const BRIEF_SECTIONS = [
  "What it is",
  "Architecture",
  "Current state",
  "Plans and next steps",
  "Known problems",
] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];
/** A brief is kept under about this many words. */
export const BRIEF_WORDS = 800;

export const BriefSourceSchema = z.enum(["task", "built", "restored"]);
export type BriefSource = z.infer<typeof BriefSourceSchema>;

/** One version of a project's living brief. Every version is kept. */
export const ProjectBriefSchema = z.object({
  project: IdSchema,
  version: z.number().int().positive(),
  /** Markdown, one `## ` heading per section. */
  body: z.string(),
  /** `task`: patched after a task record. `built`: from the repo docs and records. `restored`: an older version put back. */
  source: BriefSourceSchema,
  /** The task whose record changed it. */
  task: TaskIdSchema.optional(),
  /** The version it was restored from. */
  restored_from: z.number().int().positive().optional(),
  agent: z.string().optional(),
  created_at: z.string(),
});
export type ProjectBrief = z.infer<typeof ProjectBriefSchema>;

export const ThreadStatusSchema = z.enum(["open", "closed"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

/** Something a task left open: a Left item, a follow-up, a known issue. */
export const ThreadSchema = z.object({
  id: z.number().int().positive(),
  text: z.string(),
  project: IdSchema.optional(),
  org: IdSchema.optional(),
  /** The task whose record left it open. */
  task: TaskIdSchema,
  /** A task made to do it. The thread closes when that task is done. */
  follow_up: TaskIdSchema.optional(),
  status: ThreadStatusSchema,
  /** `owner`, `task:<id>` (a later record says it was done) or `follow-up:<id>`. */
  closed_by: z.string().optional(),
  closed_reason: z.string().optional(),
  created_at: z.string(),
  closed_at: z.string().optional(),
});
export type Thread = z.infer<typeof ThreadSchema>;

/** The Memory section of TASK.md is capped at about this many tokens. */
export const TASK_MEMORY_TOKENS = 1_500;

export const MemoryRecordsInputSchema = z.object({
  /** Hybrid search when set; newest first otherwise. */
  query: z.string().trim().max(2000).optional(),
  project: IdSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const MemoryRecordInputSchema = z.object({ task: TaskIdSchema });

export const MemoryBriefInputSchema = z.object({ project: IdSchema });
export const MemoryBriefOutputSchema = z.object({
  /** The newest version, absent before the first. */
  current: ProjectBriefSchema.optional(),
  /** Every version, newest first. */
  versions: z.array(ProjectBriefSchema),
});

export const MemoryRestoreBriefInputSchema = z.object({
  project: IdSchema,
  version: z.number().int().positive(),
});

export const MemoryThreadsInputSchema = z.object({
  project: IdSchema.optional(),
  status: ThreadStatusSchema.optional(),
  task: TaskIdSchema.optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

export const MemoryThreadInputSchema = z.object({
  id: z.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
});

export const MemoryBulkDecideInputSchema = z.object({
  /** The pending facts to decide. Default: every pending fact. */
  ids: z.array(FactIdSchema).max(500).optional(),
});
export const MemoryBulkDecideOutputSchema = z.object({ count: z.number().int().min(0) });
