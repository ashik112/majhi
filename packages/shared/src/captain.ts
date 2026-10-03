import { z } from "zod";
import { AutonomyModeSchema, SpendSchema } from "./autonomy.ts";
import { IdSchema } from "./ids.ts";
import { AutonomyOrgSchema, BudgetSchema, CaptainLevelSchema } from "./settings.ts";
import { TaskIdSchema, TaskPrioritySchema } from "./tasks.ts";

/**
 * The captain per workspace (SPEC 5.18): the choice of how much it does, the upkeep chores it runs at
 * fixed moments, its lane (one chat per workspace), its log with Undo, and the guards that keep it
 * from running away. The rules are in docs/PROGRESS.md under Phase 13.
 */

export const LEVEL_LABEL = {
  ask: "Only when I ask",
  tidy: "Keeps things tidy",
  runs: "Runs it",
} as const satisfies Record<z.infer<typeof CaptainLevelSchema>, string>;

/** The upkeep chores (the table in 5.18). */
export const CaptainChoreSchema = z.enum([
  "ship",
  "cards",
  "questions",
  "memory",
  "projects",
  "triage",
  "cleanup",
  "stuck",
]);
export type CaptainChore = z.infer<typeof CaptainChoreSchema>;

export const CHORE_LABEL: Record<CaptainChore, string> = {
  ship: "Ship finished work",
  cards: "Approval cards",
  questions: "Agents' questions",
  memory: "Memory",
  projects: "Projects",
  triage: "Task triage",
  cleanup: "Cleanup",
  stuck: "Stuck tasks",
};

/** Who caused an event. The captain's own events never start an upkeep run. */
export const CaptainCauseSchema = z.enum(["owner", "agent", "captain", "majhi"]);
export type CaptainCause = z.infer<typeof CaptainCauseSchema>;

/**
 * How a run ended. `capped`: it reached a cap (actions, tokens, minutes) and stopped with a line in
 * the log. `stopped`: "Stop the captain", or a restart cut it short. `rested`: the workspace's hours,
 * a freeze, or its budget kept it from acting.
 */
export const CaptainRunStatusSchema = z.enum(["running", "done", "capped", "failed", "stopped", "rested"]);
export type CaptainRunStatus = z.infer<typeof CaptainRunStatusSchema>;

/** What Undo does for one action, as stored. */
export const CaptainUndoSchema = z.discriminatedUnion("kind", [
  /** A merge: a revert commit on each target branch. */
  z.object({
    kind: z.literal("revert"),
    repos: z
      .array(
        z.object({
          project: IdSchema,
          source: z.string().min(1),
          into: z.string().min(1),
          before: z.string().regex(/^[0-9a-f]{40,64}$/),
          after: z.string().regex(/^[0-9a-f]{40,64}$/),
        }),
      )
      .min(1)
      .max(20),
  }),
  /** A change to majhi.yaml or the agent files: revert that commit of the config history. */
  z.object({ kind: z.literal("config"), commit: z.string().regex(/^[0-9a-f]{7,64}$/) }),
  /** A task's priority or due date the captain set: put the old ones back. */
  z.object({
    kind: z.literal("task"),
    task: TaskIdSchema,
    priority: TaskPrioritySchema.nullable(),
    due: z.string().nullable(),
  }),
  /** A memory step (kept, merged, dropped): the memory log's own undo. */
  z.object({ kind: z.literal("memory"), event: z.number().int().positive() }),
]);
export type CaptainUndo = z.infer<typeof CaptainUndoSchema>;

/**
 * One line of the captain's log. `done`: it acted. `asked`: it handed the matter to the owner (the
 * bell has it). `skipped`: it looked and left it, with why. `failed`: the action failed.
 */
export const CaptainActionSchema = z.object({
  id: z.number().int().positive(),
  at: z.string(),
  org: z.string(),
  chore: CaptainChoreSchema,
  /** What it did, one line in plain words. */
  text: z.string(),
  /** Why, one line. */
  reason: z.string(),
  /** What it looked at, one line: the checks that passed, the card, the rule. */
  evidence: z.string().optional(),
  task: TaskIdSchema.optional(),
  outcome: z.enum(["done", "asked", "skipped", "failed"]),
  /** `yes`: Undo works. `no`: it cannot be undone (a push, a removed worktree), with `undoNote`. `done`: undone. */
  undo: z.enum(["yes", "no", "done"]).optional(),
  undoNote: z.string().optional(),
  undoneAt: z.string().optional(),
});
export type CaptainAction = z.infer<typeof CaptainActionSchema>;

export const CaptainRunSchema = z.object({
  id: z.number().int().positive(),
  org: z.string(),
  chore: CaptainChoreSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  status: CaptainRunStatusSchema,
  /** What started it, one line. */
  trigger: z.string(),
  actions: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  note: z.string().optional(),
});
export type CaptainRun = z.infer<typeof CaptainRunSchema>;

/** One chore in one workspace. */
export const CaptainChoreStateSchema = z.object({
  chore: CaptainChoreSchema,
  /** Turned off after two failures in a row, with why. Absent: on. */
  off: z.string().optional(),
  /** Actions it took today, against its daily cap. */
  today: z.number().int().nonnegative(),
  cap: z.number().int().positive(),
  lastRun: z.string().optional(),
});
export type CaptainChoreState = z.infer<typeof CaptainChoreStateSchema>;

/** One workspace on the Captain page. */
export const CaptainOrgSchema = z.object({
  org: z.string(),
  name: z.string(),
  /** The choice, defaults applied. */
  level: CaptainLevelSchema,
  /** What it does now: "Runs it" acts as "Keeps things tidy" while autonomous mode is not on. */
  effective: CaptainLevelSchema,
  /** The settings as saved, for "More rules". */
  rules: AutonomyOrgSchema,
  /** The daily budget (its cap) and what the captain and autonomous work spent here today. */
  budget: BudgetSchema.optional(),
  used: SpendSchema,
  /** Today's one line: "shipped 2, tidied 8 memories, 1 thing for you". Empty when nothing happened. */
  summary: z.string(),
  /** How many things it handed to the owner today. */
  forYou: z.number().int().nonnegative(),
  /** Why it does not act right now (outside hours, a freeze, budget reached). */
  resting: z.string().optional(),
  /** The captain's chat for this workspace. */
  lane: TaskIdSchema.optional(),
  chores: z.array(CaptainChoreStateSchema),
});
export type CaptainOrg = z.infer<typeof CaptainOrgSchema>;

/** `captain.status`. */
export const CaptainStatusSchema = z.object({
  /** Always false: the captain is never stopped, Autonomous is the switch. Kept for older clients. */
  stopped: z.boolean(),
  stoppedAt: z.string().optional(),
  /** Autonomous, the master switch for everything the captain does by itself. */
  autonomy: AutonomyModeSchema,
  /** The captain agent. Absent: none chosen yet, and nothing runs. */
  captain: IdSchema.optional(),
  /** The day the summaries cover, `YYYY-MM-DD`. */
  day: z.string(),
  orgs: z.array(CaptainOrgSchema),
});
export type CaptainStatus = z.infer<typeof CaptainStatusSchema>;

export const CaptainLogInputSchema = z.object({
  org: z.string().optional(),
  before: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export const CaptainLogResultSchema = z.object({
  actions: z.array(CaptainActionSchema),
  runs: z.array(CaptainRunSchema),
});

export const CaptainUndoInputSchema = z.object({ id: z.number().int().positive() });
export const CaptainUndoResultSchema = z.object({ action: CaptainActionSchema, detail: z.string() });

export const CaptainChoreInputSchema = z.object({
  org: z.string().min(1).max(63),
  chore: CaptainChoreSchema,
});

/**
 * A chore reached its daily cap in a workspace, and the captain asks the owner whether to raise it
 * for today: one per chore, workspace and day. `kind` says which cap it reached, actions or runs.
 * "Raise" doubles the chore's caps for that day only; "Leave it" keeps them.
 */
export const CaptainCapAskSchema = z.object({
  org: z.string(),
  chore: CaptainChoreSchema,
  /** The workspace's day, `YYYY-MM-DD`. */
  day: z.string(),
  kind: z.enum(["actions", "runs"]),
  /** The cap it reached. */
  cap: z.number().int().positive(),
  /** The cap for the rest of the day after "Raise". */
  raiseTo: z.number().int().positive(),
  /** "Pyzasoft: the captain answered its 20 questions for today. Raise the limit for today?" */
  text: z.string(),
  at: z.string(),
});
export type CaptainCapAsk = z.infer<typeof CaptainCapAskSchema>;

/** `captain.asks`: what the captain asks the owner about its caps today. */
export const CaptainAsksSchema = z.object({ asks: z.array(CaptainCapAskSchema) });

export const CaptainCapAnswerInputSchema = z.object({
  org: z.string().min(1).max(63),
  chore: CaptainChoreSchema,
  answer: z.enum(["raise", "leave"]),
});

/** Agent slots under the concurrency limits (5.17): held by running agents, waiting in line, free. */
export const SlotRoomSchema = z.object({
  inUse: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  free: z.number().int().nonnegative(),
});
export type SlotRoom = z.infer<typeof SlotRoomSchema>;

/** `tasks.slots`: free agent slots overall (`agents_max`) and per account (`per_account`), for planning. */
export const SlotCapacitySchema = z.object({
  agents: SlotRoomSchema,
  accounts: z.array(SlotRoomSchema.extend({ account: z.string() })),
});
export type SlotCapacity = z.infer<typeof SlotCapacitySchema>;
