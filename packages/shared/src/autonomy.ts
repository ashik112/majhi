import { z } from "zod";
import { ToolIdSchema, UsageWindowSchema } from "./accounts.ts";
import { IdSchema } from "./ids.ts";
import { AutonomyInstructionSchema, AutonomySettingsSchema, BudgetSchema } from "./settings.ts";
import { RoomItemSchema, TaskIdSchema, TaskPrioritySchema, TaskStatusSchema } from "./tasks.ts";

/**
 * Autonomous mode (PRV-74): the boss runs the desk like the owner would, inside the caps, the
 * account floors and the hard limits, and explains each decision in one line. The rules are in
 * docs/PROGRESS.md under PRV-74.
 */

/**
 * `off`: nothing autonomous runs. `on`: the boss picks work and does it. `paused`: the boss gets no
 * ticks and autonomous tasks pause after their current turn, until Resume. `stopping`: Stop
 * gracefully was pressed; current turns finish, nothing new starts, then majhi turns it `off`.
 */
export const AutonomyModeSchema = z.enum(["off", "on", "paused", "stopping"]);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

/** Tokens (input + output + cache write, as budgets count them) and dollars. */
export const SpendSchema = z.object({ tokens: z.number().nonnegative(), cost: z.number().nonnegative() });
export type Spend = z.infer<typeof SpendSchema>;

/** Today's spend against one cap. */
export const CapUseSchema = z.object({
  used: SpendSchema,
  /** Absent: no cap (an org without its own cap). */
  cap: BudgetSchema.optional(),
  /** Share of the cap used, 0 and up. With tokens and cost, the larger. 0 without a cap. */
  percent: z.number().nonnegative(),
  /** At or over the cap: no new work starts in this scope today. */
  reached: z.boolean(),
});
export type CapUse = z.infer<typeof CapUseSchema>;

export const AutonomySpendSchema = z.object({
  /** The owner's day, `YYYY-MM-DD` in `tz`, and when it ends (UTC ISO). */
  day: z.string(),
  tz: z.string(),
  resetsAt: z.string(),
  /** Everything autonomous mode ran today: its tasks and the boss's autonomy chat. */
  total: CapUseSchema,
  /** Per org: every org with a cap or with spend today. `private` stands for tasks with no org. */
  orgs: z.array(CapUseSchema.extend({ org: z.string() })),
});
export type AutonomySpend = z.infer<typeof AutonomySpendSchema>;

/** One account as autonomous mode sees it: its windows, and whether a floor holds it. */
export const AutonomyAccountSchema = z.object({
  id: IdSchema,
  org: IdSchema,
  tool: ToolIdSchema,
  window: UsageWindowSchema.optional(),
  weekly: UsageWindowSchema.optional(),
  /** Under a floor: no new autonomous work starts on it until `until` (the window's reset). */
  blocked: z.object({ why: z.string(), until: z.string().optional() }).optional(),
});
export type AutonomyAccount = z.infer<typeof AutonomyAccountSchema>;

/** Something that keeps new work from starting right now, while the mode is on. */
export const AutonomyHoldSchema = z.object({
  kind: z.enum(["day-cap", "org-cap", "account"]),
  /** The org or account it holds; absent for the overall day cap. */
  id: z.string().optional(),
  /** One line, like "Acme reached its $5.00 cap for today". */
  text: z.string(),
  /** When it lifts by itself (the day's end, a window's reset), UTC ISO. */
  until: z.string().optional(),
});
export type AutonomyHold = z.infer<typeof AutonomyHoldSchema>;

/** One autonomous task and what its agents are doing. */
export const AutonomyNowSchema = z.object({
  task: TaskIdSchema,
  title: z.string(),
  org: IdSchema.optional(),
  status: TaskStatusSchema,
  agents: z.array(z.object({ id: IdSchema, nowDoing: z.string().optional() })),
  /** The boss's one-line reason for taking it on, when the call that started or created it gave one. */
  why: z.string().optional(),
});
export type AutonomyNow = z.infer<typeof AutonomyNowSchema>;

/** One entry of the queue the boss plans next (`autonomy.plan`). */
export const QueueItemSchema = z.object({
  /** What it will do, in a few words. */
  title: z.string().trim().min(1).max(200),
  /** The task it will start or continue, when there is one. */
  task: TaskIdSchema.optional(),
  org: IdSchema.optional(),
  /** One line: why this, and why in this place. */
  why: z.string().trim().min(1).max(240),
  /** Not before this time, UTC ISO: an account's reset, a deadline's day. */
  after: z.string().optional(),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

/**
 * How much work a task is, from the decision provider's rating (Laya's `trivial` counts as small).
 * The pick rules compare it with `pick.size`.
 */
export const TaskSizeSchema = z.enum(["small", "medium", "large"]);
export type TaskSize = z.infer<typeof TaskSizeSchema>;

/** An inbox or ready task autonomous mode could take, as the pick rules see it. */
export const AutonomyBacklogItemSchema = z.object({
  task: TaskIdSchema,
  title: z.string(),
  org: IdSchema.optional(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema.optional(),
  due: z.string().optional(),
  /** Absent: not rated yet, or the rating was not sure enough to count. */
  size: TaskSizeSchema.optional(),
  /** How the size is known, one line: "Laya rated it medium (0.62)", "Not rated yet". */
  sizeNote: z.string(),
  /** The owner marked it Not for autonomous mode. */
  noAutonomy: z.boolean(),
  /** Why the pick rules leave it out, one line. Absent: the boss may take it. */
  leftOut: z.string().optional(),
});
export type AutonomyBacklogItem = z.infer<typeof AutonomyBacklogItemSchema>;

/** A card in an autonomous task that only the owner can decide, and why autonomous mode left it. */
export const AutonomyWaitingSchema = z.object({
  task: TaskIdSchema,
  /** The room item, to open it. */
  item: z.string(),
  /** The item's type: approval, permission, secret-request, ask, choice, owner-question, review. */
  kind: z.string(),
  /** What it is, one line. */
  text: z.string(),
  /** Why autonomous mode did not decide it, one line. */
  why: z.string(),
});
export type AutonomyWaiting = z.infer<typeof AutonomyWaitingSchema>;

/**
 * The feed. `mode`: turned on, paused, resumed, stopping, stopped. `tick`: majhi woke the boss, and
 * why. `decision`: the boss chose something, with its one-line reason (a note, or a call that
 * changed something). `approval`: a card approved within the limits or left for the owner.
 * `refused`: a hard limit stopped a call. `task`: an autonomous task started, went to review, was
 * shipped, paused or failed. `answer`: the boss answered an agent's question or prompt. `guide`: the
 * owner's message, an instruction saved or removed. `cap`: a cap or a floor started or stopped
 * holding new work. `summary`: the daily summary was made.
 */
export const AutonomyEventKindSchema = z.enum([
  "mode",
  "tick",
  "decision",
  "approval",
  "refused",
  "task",
  "answer",
  "guide",
  "cap",
  "summary",
]);
export type AutonomyEventKind = z.infer<typeof AutonomyEventKindSchema>;

export const AutonomyEventSchema = z.object({
  seq: z.number().int().positive(),
  /** UTC ISO. */
  at: z.string(),
  kind: AutonomyEventKindSchema,
  /** What happened, one line in plain words. Never holds a secret. */
  text: z.string(),
  /** The boss's one-line reason, when it gave one. */
  reason: z.string().optional(),
  task: TaskIdSchema.optional(),
  org: z.string().optional(),
  agent: IdSchema.optional(),
  command: z.string().optional(),
  /** For approvals and calls. */
  outcome: z.enum(["applied", "left", "refused", "failed"]).optional(),
  /** The boss is not sure about this one: it goes into the daily summary. */
  unsure: z.boolean().optional(),
  /** The room item it is about, to open it. */
  item: z.string().optional(),
  /** For `task` events: the status the task reached. The daily summary reads it. */
  status: TaskStatusSchema.optional(),
});
export type AutonomyEvent = z.infer<typeof AutonomyEventSchema>;

/** The daily summary: what autonomous mode shipped, what it spent, what it is unsure about. */
export const AutonomySummarySchema = z.object({
  /** The day it covers, `YYYY-MM-DD` in the settings' zone, and the span, UTC ISO. */
  day: z.string(),
  from: z.string(),
  to: z.string(),
  /** When it was made, UTC ISO. */
  at: z.string(),
  shipped: z.array(
    z.object({
      task: TaskIdSchema,
      title: z.string(),
      org: IdSchema.optional(),
      /** How far it went: merged locally, pushed, an MR opened or merged, or ready for the owner's review. */
      how: z.enum(["merged", "pushed", "mr-open", "mr-merged", "review", "done"]),
    }),
  ),
  spent: z.object({
    total: CapUseSchema,
    orgs: z.array(CapUseSchema.extend({ org: z.string() })),
  }),
  /** Decisions it marked unsure, and calls a hard limit refused. */
  unsure: z.array(z.object({ text: z.string(), task: TaskIdSchema.optional(), item: z.string().optional() })),
  /** Cards still waiting for the owner when it was made. */
  waiting: z.array(AutonomyWaitingSchema),
  /** How many decisions it logged in the span. */
  decisions: z.number().int().nonnegative(),
});
export type AutonomySummary = z.infer<typeof AutonomySummarySchema>;

/** `autonomy.status`. */
export const AutonomyStatusSchema = z.object({
  mode: AutonomyModeSchema,
  /** When the mode last changed (UTC ISO), who changed it, and majhi's reason when it did. */
  since: z.string().optional(),
  by: z.enum(["owner", "majhi"]).optional(),
  why: z.string().optional(),
  /** The boss and its autonomy chat. Absent: there is no boss, and turning on is refused. */
  boss: z
    .object({
      id: IdSchema,
      chat: TaskIdSchema.optional(),
      working: z.boolean(),
      nowDoing: z.string().optional(),
    })
    .optional(),
  /** Autonomous tasks that are not done, running ones first. */
  now: z.array(AutonomyNowSchema),
  queue: z.array(QueueItemSchema),
  /** Inbox and ready tasks in the order the boss reads them, each with its size and whether the rules leave it out. */
  backlog: z.array(AutonomyBacklogItemSchema),
  /** When the boss last set the queue, UTC ISO. */
  queuedAt: z.string().optional(),
  holds: z.array(AutonomyHoldSchema),
  spend: AutonomySpendSchema,
  accounts: z.array(AutonomyAccountSchema),
  waiting: z.array(AutonomyWaitingSchema),
  settings: AutonomySettingsSchema,
  /** The newest daily summary. */
  summary: AutonomySummarySchema.optional(),
  /** When majhi last woke the boss, UTC ISO. */
  lastTick: z.string().optional(),
});
export type AutonomyStatus = z.infer<typeof AutonomyStatusSchema>;

// ---------------------------------------------------------------------------
// Command inputs

export const AutonomyEventsInputSchema = z.object({
  /** Events older than this `seq`, for the next page. */
  before: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  /** Only decisions, approvals and refusals: the "Decisions" list. */
  decisions: z.boolean().default(false),
  task: TaskIdSchema.optional(),
});

/** `autonomy.plan`: the boss replaces its queue. */
export const AutonomyPlanInputSchema = z.object({ items: z.array(QueueItemSchema).max(20) });

/** `autonomy.note`: a decision that is not a call, like waiting for a reset or skipping an org. */
export const AutonomyNoteInputSchema = z.object({
  text: z.string().trim().min(1).max(240),
  task: TaskIdSchema.optional(),
  org: IdSchema.optional(),
  unsure: z.boolean().default(false),
});

/**
 * `autonomy.answer`: the boss answers a card in an autonomous task as the owner would. `option` for
 * a permission prompt or a choice (the option id) and an owner question (the choice); `answers` for
 * an ask card (question id to option id or free text).
 */
export const AutonomyAnswerInputSchema = z
  .object({
    task: TaskIdSchema,
    item: z.string().min(1).max(200),
    option: z.string().trim().min(1).max(200).optional(),
    answers: z.record(z.string(), z.string().max(2000)).optional(),
  })
  .refine((v) => (v.option === undefined) !== (v.answers === undefined), {
    message: "Give option, or answers for an ask card",
  });

/** `autonomy.guide`: the owner's message from the chat box. `keep` saves it as a standing instruction. */
export const AutonomyGuideInputSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  keep: z.boolean().default(false),
});
export const AutonomyGuideResultSchema = z.object({
  /** The autonomy chat the message went to. */
  chat: TaskIdSchema,
  instruction: AutonomyInstructionSchema.optional(),
});

export const AutonomyStopInputSchema = z.object({ how: z.enum(["now", "graceful"]) });

/** `autonomy.exclude`: the owner marks a task Not for autonomous mode, or clears the mark. */
export const AutonomyExcludeInputSchema = z.object({ task: TaskIdSchema, exclude: z.boolean() });

/** The boss's own tools: no approval card, only for the boss in its autonomy chat while the mode is not off. */
export const AUTONOMY_BOSS_COMMANDS = ["autonomy.plan", "autonomy.note", "autonomy.answer"] as const;

/** What `autonomy.answer` returns. */
export const AutonomyAnswerResultSchema = z.object({ item: RoomItemSchema });
