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
