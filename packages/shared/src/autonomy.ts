import { z } from "zod";
import { AccountStatusSchema, ToolIdSchema, UsageWindowSchema } from "./accounts.ts";
import { IdSchema } from "./ids.ts";
import { AutonomyInstructionSchema, AutonomySettingsSchema, BudgetSchema } from "./settings.ts";
import { RoomItemSchema, TaskIdSchema, TaskPrioritySchema, TaskStatusSchema } from "./tasks.ts";

/**
 * Autonomous mode (PRV-74): the captain runs the desk like the owner would, inside the caps, the
 * account floors and the hard limits, and explains each decision in one line. The rules are in
 * docs/PROGRESS.md under PRV-74.
 */

/**
 * `off`: nothing autonomous runs. `on`: the captain picks work and does it. `paused`: the captain gets no
 * ticks and autonomous tasks pause after their current turn, until Resume. `stopping`: Stop
 * gracefully was pressed; current turns finish, nothing new starts, then majhi turns it `off`.
 */
export const AutonomyModeSchema = z.enum(["off", "on", "paused", "stopping"]);
// `paused` is no state any more: a database that holds it reads as `on`. `stopping` is the moment
// between "let them finish this step" and Off.
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
  /** In a daily summary: the cap moved during the day it covers, and `cap` is the last one. */
  changed: z.literal(true).optional(),
});
export type CapUse = z.infer<typeof CapUseSchema>;

export const AutonomySpendSchema = z.object({
  /** The owner's day, `YYYY-MM-DD` in `tz`, and when it ends (UTC ISO). */
  day: z.string(),
  tz: z.string(),
  resetsAt: z.string(),
  /** Everything autonomous mode ran today: its tasks and the captain's autonomy chat. */
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
  /** The account's health right now: signed in, signed out (`needs-login`), at its limit, unreachable. */
  status: AccountStatusSchema.optional(),
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
  /** The captain's one-line reason for taking it on, when the call that started or created it gave one. */
  why: z.string().optional(),
  /** When autonomous mode took the task on (UTC ISO): the start of its elapsed time. */
  since: z.string().optional(),
  /** For a paused task: who paused it, in words, and whether the captain may resume it now. */
  pause: z.object({ label: z.string(), mayResume: z.boolean(), stays: z.string().optional() }).optional(),
});
export type AutonomyNow = z.infer<typeof AutonomyNowSchema>;

/** One entry of the queue the captain plans next (`autonomy.plan`). */
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
  /**
   * It waits for an account: `signed-in` once the account is signed in (any state but signed out or
   * unreachable), `available` once it is also under its limit. majhi reads the account each minute,
   * sets `readyAt` when the wait lifts and wakes the captain with one line.
   */
  waitFor: z.object({ account: IdSchema, state: z.enum(["signed-in", "available"]) }).optional(),
  /** Set by majhi: when the account condition of `waitFor` came true. Cleared when it stops holding. */
  readyAt: z.string().optional(),
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
  /** Why the pick rules leave it out, one line. Absent: the captain may take it. */
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
  /** When the card appeared (UTC ISO), to show how long it waits. */
  at: z.string().optional(),
});
export type AutonomyWaiting = z.infer<typeof AutonomyWaitingSchema>;

/**
 * The feed. `mode`: turned on, paused, resumed, stopping, stopped. `tick`: majhi woke the captain, and
 * why. `decision`: the captain chose something, with its one-line reason (a note, or a call that
 * changed something). `approval`: a card approved within the limits or left for the owner.
 * `refused`: a hard limit stopped a call. `task`: an autonomous task started, went to review, was
 * shipped, paused or failed. `answer`: the captain answered an agent's question or prompt. `guide`: the
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
  /** The captain's one-line reason, when it gave one. */
  reason: z.string().optional(),
  task: TaskIdSchema.optional(),
  org: z.string().optional(),
  agent: IdSchema.optional(),
  command: z.string().optional(),
  /** For approvals and calls. */
  outcome: z.enum(["applied", "left", "refused", "failed"]).optional(),
  /** The captain is not sure about this one: it goes into the daily summary. */
  unsure: z.boolean().optional(),
  /** The room item it is about, to open it. */
  item: z.string().optional(),
  /** For `task` events: the status the task reached. The daily summary reads it. */
  status: TaskStatusSchema.optional(),
});
export type AutonomyEvent = z.infer<typeof AutonomyEventSchema>;

/** How many titles the daily summary names in a list before "and N more". */
export const SUMMARY_TITLES = 3;

/** The daily summary: what autonomous mode shipped, what it spent, what it is unsure about. */
export const AutonomySummarySchema = z.object({
  /**
   * The day it covers, `YYYY-MM-DD` in the settings' zone: the day before the one it was made on.
   * The span is that day, midnight to midnight, UTC ISO.
   */
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
  /** Per workspace: how many shipped and the first three titles, biggest first. Summaries made before it have none. */
  shipGroups: z
    .array(
      z.object({
        org: z.string(),
        /** The workspace's name; the id when it has none. */
        name: z.string(),
        count: z.number().int().positive(),
        titles: z.array(z.string()).max(SUMMARY_TITLES),
      }),
    )
    .default([]),
  spent: z.object({
    total: CapUseSchema,
    orgs: z.array(CapUseSchema.extend({ org: z.string(), name: z.string().optional() })),
  }),
  /** Decisions it marked unsure, and calls a hard limit refused. */
  unsure: z.array(z.object({ text: z.string(), task: TaskIdSchema.optional(), item: z.string().optional() })),
  /** Cards still waiting for the owner when it was made. */
  waiting: z.array(AutonomyWaitingSchema).default([]),
  /** What waits in the owner's Decisions inbox when it was made: the count and the oldest three. */
  needs: z
    .object({
      count: z.number().int().nonnegative(),
      top: z
        .array(z.object({ id: z.string(), title: z.string(), org: z.string().optional() }))
        .max(SUMMARY_TITLES),
    })
    .optional(),
  /** The first three entries of the captain's queue: what it plans next, and why. */
  next: z
    .array(
      z.object({
        title: z.string(),
        why: z.string(),
        task: TaskIdSchema.optional(),
        org: z.string().optional(),
      }),
    )
    .max(SUMMARY_TITLES)
    .default([]),
  /** How many upkeep actions the captain took that day (memory, cards, projects, cleanup), not counting ships. */
  upkeep: z.number().int().nonnegative().default(0),
  /** How many decisions it logged in the span. */
  decisions: z.number().int().nonnegative(),
});
export type AutonomySummary = z.infer<typeof AutonomySummarySchema>;

/**
 * One workspace where the captain starts work (5.18): the captain's lane there, and what autonomous mode does in
 * it today. The lane's chat holds only that workspace's matters.
 */
export const AutonomyLaneSchema = z.object({
  org: z.string(),
  name: z.string(),
  /** The lane's chat. Absent until the captain is first woken there. */
  chat: TaskIdSchema.optional(),
  /** The captain is in a turn in this lane. */
  working: z.boolean(),
  nowDoing: z.string().optional(),
  /** Today's spend in this workspace against its daily budget. */
  spend: CapUseSchema,
  /** Autonomous tasks of this workspace that are not done. */
  tasks: z.number().int().nonnegative(),
  /** Backlog tasks the rules let it take here. */
  backlog: z.number().int().nonnegative(),
  /** Why no new work starts here now: its budget, the day budget, hours, a freeze. */
  resting: z.string().optional(),
});
export type AutonomyLane = z.infer<typeof AutonomyLaneSchema>;

/** `autonomy.status` input: `detail` adds the task lists, the backlog and the waiting cards. */
export const AutonomyStatusInputSchema = z.object({ detail: z.boolean().default(false) });

/** `autonomy.status`. */
export const AutonomyStatusSchema = z.object({
  mode: AutonomyModeSchema,
  /** When the mode last changed (UTC ISO), who changed it, and majhi's reason when it did. */
  since: z.string().optional(),
  by: z.enum(["owner", "majhi"]).optional(),
  why: z.string().optional(),
  /**
   * The captain, and the chat the page shows first: the first lane with a chat, else the autonomy
   * chat from before lanes (readable, never woken). Absent: there is no captain, and turning on is refused.
   */
  boss: z
    .object({
      id: IdSchema,
      chat: TaskIdSchema.optional(),
      working: z.boolean(),
      nowDoing: z.string().optional(),
    })
    .optional(),
  /** Each workspace where the captain starts work, in the order of the workspaces. */
  lanes: z.array(AutonomyLaneSchema).default([]),
  /** Autonomous tasks that are not done, running ones first. */
  now: z.array(AutonomyNowSchema).default([]),
  /** Autonomous tasks that are running now, always sent. */
  running: z.array(TaskIdSchema).default([]),
  queue: z.array(QueueItemSchema),
  /** Inbox and ready tasks in the order the captain reads them, each with its size and whether the rules leave it out. */
  backlog: z.array(AutonomyBacklogItemSchema).default([]),
  /** When the captain last set the queue, UTC ISO. */
  queuedAt: z.string().optional(),
  holds: z.array(AutonomyHoldSchema),
  spend: AutonomySpendSchema,
  accounts: z.array(AutonomyAccountSchema),
  waiting: z.array(AutonomyWaitingSchema),
  settings: AutonomySettingsSchema,
  /** The newest daily summary. */
  summary: AutonomySummarySchema.optional(),
  /** When majhi last woke the captain, UTC ISO. */
  lastTick: z.string().optional(),
  /** Tasks Stop now paused that are still paused: turning on can resume them. */
  stopped: z.array(TaskIdSchema).default([]),
  /**
   * Budgets the owner raised for today only, by scope (`day` or a workspace id). `spend` already
   * counts them; `settings` holds the saved budgets, which they never change.
   */
  raised: z.record(z.string(), BudgetSchema).default({}),
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

/** `autonomy.report`: the charts of the Auto-pilot dashboard. `days` is how far back finished tasks go. */
export const AutonomyReportInputSchema = z.object({ days: z.number().int().min(1).max(30).default(14) });

/** Why a task shows in the dashboard's Stuck list: a running task or one in review that has gone quiet. */
export const StuckKindSchema = z.enum(["idle", "waiting"]);
export type StuckKind = z.infer<typeof StuckKindSchema>;

export const StuckTaskSchema = z.object({
  task: TaskIdSchema,
  title: z.string(),
  org: z.string().optional(),
  kind: StuckKindSchema,
  /** Since when it has not moved (UTC ISO). */
  since: z.string(),
  /** One line: what it is quiet about. */
  text: z.string(),
});
export type StuckTask = z.infer<typeof StuckTaskSchema>;

/** The owner's computer and majhi's containers, as the machine sensor last read them. */
export const AutonomyMachineSchema = z.object({
  cores: z.number().int().positive(),
  load1: z.number().nonnegative(),
  idleCpuPct: z.number().optional(),
  memFreePct: z.number().optional(),
  diskFreeGb: z.number().optional(),
  containers: z.number().int().nonnegative(),
  /** Why new work does not start: the machine is busy. */
  busy: z.string().optional(),
});
export type AutonomyMachine = z.infer<typeof AutonomyMachineSchema>;

/** `autonomy.report`: today's spend by hour and the tasks the captain finished, by day and workspace. */
export const AutonomyReportSchema = z.object({
  tz: z.string(),
  /** Today in `tz`, `YYYY-MM-DD`. */
  today: z.string(),
  /** Auto-pilot spend today, one entry per hour from midnight to the end of the current hour (UTC ISO start). */
  hours: z.array(z.object({ start: z.string(), cost: z.number(), tokens: z.number().int() })),
  /** Tasks that reached review, an MR or done, one entry per day oldest first, today last. */
  days: z.array(
    z.object({
      day: z.string(),
      orgs: z.array(z.object({ org: z.string(), count: z.number().int().positive() })),
    }),
  ),
  /** Auto-pilot spend per day and workspace over the same days, oldest first. */
  spend: z
    .array(
      z.object({
        day: z.string(),
        orgs: z.array(z.object({ org: z.string(), cost: z.number().positive() })),
      }),
    )
    .default([]),
  /** Tasks started, finished and paused per day over the same days, oldest first. A task counts once per day and kind. */
  flow: z
    .array(
      z.object({
        day: z.string(),
        started: z.number().int().nonnegative(),
        finished: z.number().int().nonnegative(),
        paused: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  /** Autonomous tasks and cards that are not moving, longest first. */
  stuck: z.array(StuckTaskSchema).default([]),
  /** Absent while the host helper is not connected. */
  machine: AutonomyMachineSchema.optional(),
});
export type AutonomyReport = z.infer<typeof AutonomyReportSchema>;

/** `autonomy.plan`: the captain replaces its queue. */
export const AutonomyPlanInputSchema = z.object({ items: z.array(QueueItemSchema).max(20) });

/** `autonomy.note`: a decision that is not a call, like waiting for a reset or skipping an org. */
export const AutonomyNoteInputSchema = z.object({
  text: z.string().trim().min(1).max(240),
  task: TaskIdSchema.optional(),
  org: IdSchema.optional(),
  unsure: z.boolean().default(false),
});

/**
 * `autonomy.answer`: the captain answers a card in an autonomous task as the owner would. `option` for
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
  /** The workspace whose lane hears it. Default: the first workspace where the captain starts work. */
  org: z.string().min(1).max(63).optional(),
});
export const AutonomyGuideResultSchema = z.object({
  /** The autonomy chat the message went to. */
  chat: TaskIdSchema,
  instruction: AutonomyInstructionSchema.optional(),
});

export const AutonomyStopInputSchema = z.object({ how: z.enum(["now", "graceful"]) });

/** `autonomy.start`: `resumeStopped` also resumes the tasks Stop now paused (`status.stopped`). */
export const AutonomyStartInputSchema = z.object({ resumeStopped: z.boolean().default(false) });

/** `autonomy.exclude`: the owner marks a task Not for autonomous mode, or clears the mark. */
export const AutonomyExcludeInputSchema = z.object({ task: TaskIdSchema, exclude: z.boolean() });

/** The captain's own tools: no approval card, only for the captain in its autonomy chat while the mode is not off. */
export const AUTONOMY_BOSS_COMMANDS = [
  "autonomy.plan",
  "autonomy.note",
  "autonomy.answer",
  "decisions.recommend",
] as const;

/** What `autonomy.answer` returns. */
export const AutonomyAnswerResultSchema = z.object({ item: RoomItemSchema });
