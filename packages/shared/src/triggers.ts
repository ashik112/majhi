import { z } from "zod";
import { IdSchema } from "./accounts.ts";
import { AutomationActionSchema, AutomationRunSchema, OverlapPolicySchema } from "./automation.ts";
import { TaskIdSchema } from "./tasks.ts";

/**
 * Watch triggers: a condition majhi checks now and then, and an action it runs when the condition
 * matches. The action, the overlap rule and the run records are the ones schedules use (see
 * `automation.ts`). The engine is in `apps/server/src/automation/triggers`.
 */

/** What a watch looks at. Each kind says in `describeWatch` what counts as a match. */
export const TaskStatusWatchSchema = z.object({
  kind: z.literal("task.status"),
  /** One task, or every task of the trigger's org. */
  task: TaskIdSchema.optional(),
  /** `failed`: the task paused on an error. `needs-you`: in review, an MR is open, or it paused (a failed task counts). */
  to: z.enum(["done", "failed", "needs-you"]),
});

export const MrWatchSchema = z.object({
  kind: z.literal("mr.changed"),
  /** One task, or every task of the trigger's org. Fires when an MR opens or its state or checks change. */
  task: TaskIdSchema.optional(),
});

export const BranchWatchSchema = z.object({
  kind: z.literal("branch.changed"),
  project: IdSchema,
  /** A local branch of the project's checkout. Task branches live there too. */
  branch: z.string().trim().min(1).max(200),
});

export const PathWatchSchema = z.object({
  kind: z.literal("path.changed"),
  project: IdSchema,
  /** A file or folder inside the project's checkout, relative to it. A folder counts everything in it. */
  path: z.string().trim().min(1).max(500),
});

export const ProcessWatchSchema = z.object({
  kind: z.literal("process.exit"),
  task: TaskIdSchema,
  /** A process id (`p1`) or name in the task. Default: any process of the task. */
  process: z.string().trim().min(1).max(80).optional(),
  /** `failure`: only an exit code other than 0, or a signal. */
  on: z.enum(["any", "failure"]).default("any"),
});

export const UsageMetricSchema = z.enum(["costUsd", "totalTokens"]);
export const UsagePeriodSchema = z.enum(["today", "week", "month"]);

export const UsageWatchSchema = z.object({
  kind: z.literal("usage.over"),
  metric: UsageMetricSchema,
  period: UsagePeriodSchema,
  /** The trigger's org, counted over `period`. Fires when it goes above this, once per crossing. */
  limit: z.number().positive().max(1e12),
});

export const UrlWatchSchema = z.object({
  kind: z.literal("url.changed"),
  /** http or https. The status and the first megabyte of the body are compared. */
  url: z.string().trim().min(1).max(2_000),
});

export const CommandWatchSchema = z.object({
  kind: z.literal("command.changed"),
  /** The command runs in this task as a process, like `majhi-processes`. */
  task: TaskIdSchema,
  command: z.string().trim().min(1).max(4_000),
  cwd: z.string().trim().min(1).max(1_000).optional(),
});

export const WatchSpecSchema = z.discriminatedUnion("kind", [
  TaskStatusWatchSchema,
  MrWatchSchema,
  BranchWatchSchema,
  PathWatchSchema,
  ProcessWatchSchema,
  UsageWatchSchema,
  UrlWatchSchema,
  CommandWatchSchema,
]);
export type WatchSpec = z.output<typeof WatchSpecSchema>;
export type WatchKind = WatchSpec["kind"];

/** Kinds that fetch or run something: they are checked less often. */
const SLOW_KINDS: readonly WatchKind[] = ["url.changed", "command.changed"];

/** Seconds between checks when the trigger sets none. */
export function defaultPollSeconds(kind: WatchKind): number {
  switch (kind) {
    case "url.changed":
    case "command.changed":
      return 300;
    case "usage.over":
      return 60;
    case "branch.changed":
    case "path.changed":
      return 30;
    default:
      return 10;
  }
}

/** The fewest seconds between checks. A URL or a command is not hit more often than once a minute. */
export function minPollSeconds(kind: WatchKind): number {
  return SLOW_KINDS.includes(kind) ? 60 : 5;
}

/** Quiet seconds a change must hold before it fires, default. */
export const DEFAULT_SETTLE_SECONDS = 0;
/** After a firing the trigger waits this long before it fires again, default. */
export const DEFAULT_COOLDOWN_SECONDS = 300;

/** One plain line: what the trigger watches for. */
export function describeWatch(spec: WatchSpec): string {
  switch (spec.kind) {
    case "task.status": {
      const what = spec.to === "needs-you" ? "needs you" : spec.to === "failed" ? "fails" : "is done";
      return `${spec.task === undefined ? "Any task" : `Task ${spec.task}`} ${what}`;
    }
    case "mr.changed":
      return `${spec.task === undefined ? "Any task's" : `Task ${spec.task}'s`} merge request changes`;
    case "branch.changed":
      return `Branch ${spec.branch} of ${spec.project} moves`;
    case "path.changed":
      return `${spec.path} in ${spec.project} changes`;
    case "process.exit":
      return `${spec.process === undefined ? "A process" : `Process ${spec.process}`} of ${spec.task} exits${spec.on === "failure" ? " with an error" : ""}`;
    case "usage.over":
      return `${spec.metric === "costUsd" ? "Cost" : "Tokens"} ${spec.period === "today" ? "today" : `this ${spec.period}`} goes over ${spec.limit}${spec.metric === "costUsd" ? " USD" : ""}`;
    case "url.changed":
      return `${spec.url} changes`;
    case "command.changed":
      return `The output of \`${spec.command}\` in ${spec.task} changes`;
  }
}

// ---------------------------------------------------------------------------
// Triggers

export const TriggerIdSchema = z.string().regex(/^trg-[a-z0-9]{6,20}$/, "Not a trigger id");

const Seconds = (min: number) => z.number().int().min(min).max(86_400);

export const TriggerViewSchema = z.object({
  id: TriggerIdSchema,
  org: IdSchema,
  name: z.string(),
  watch: WatchSpecSchema,
  /** `watch` in words. */
  watching: z.string(),
  action: AutomationActionSchema,
  overlap: OverlapPolicySchema,
  paused: z.boolean(),
  /** Seconds between checks. */
  pollSeconds: z.number().int(),
  /** Seconds a change must hold still before it fires. */
  settleSeconds: z.number().int(),
  /** Seconds after a firing before the next one. */
  cooldownSeconds: z.number().int(),
  /** UTC, ISO 8601. Null until the first check after majhi started. */
  lastCheckedAt: z.string().nullable(),
  /** Why the last check could not look, if it could not. Null when it could. */
  checkError: z.string().nullable(),
  /** A change was seen and waits for the settle time or the cooldown. */
  pending: z.boolean(),
  /** The last time it fired. */
  lastFiredAt: z.string().nullable(),
  /** The last run, with its outcome. */
  lastRun: AutomationRunSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TriggerView = z.infer<typeof TriggerViewSchema>;

export const TriggerCreateInputSchema = z.object({
  org: IdSchema,
  name: z.string().trim().min(1).max(120),
  watch: WatchSpecSchema,
  /**
   * What runs. `{{event}}` in the text of a message or a started task becomes a line about what
   * matched, like "task ACM-4 reached done".
   */
  action: AutomationActionSchema,
  overlap: OverlapPolicySchema.default("skip"),
  pollSeconds: Seconds(5).optional(),
  settleSeconds: Seconds(0).default(DEFAULT_SETTLE_SECONDS),
  cooldownSeconds: Seconds(0).default(DEFAULT_COOLDOWN_SECONDS),
});
export type TriggerCreateInput = z.output<typeof TriggerCreateInputSchema>;

export const TriggerUpdateInputSchema = z.object({
  id: TriggerIdSchema,
  name: z.string().trim().min(1).max(120).optional(),
  watch: WatchSpecSchema.optional(),
  action: AutomationActionSchema.optional(),
  overlap: OverlapPolicySchema.optional(),
  pollSeconds: Seconds(5).optional(),
  settleSeconds: Seconds(0).optional(),
  cooldownSeconds: Seconds(0).optional(),
});
export type TriggerUpdateInput = z.output<typeof TriggerUpdateInputSchema>;
