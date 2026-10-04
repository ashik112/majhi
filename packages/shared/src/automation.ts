import { z } from "zod";
import { IdSchema } from "./accounts.ts";
import { cronProblem, isTimeZone, onceInstant } from "./schedule-time.ts";
import { TaskIdSchema } from "./tasks.ts";

/**
 * Schedules and watch triggers share what they do (an action) and what they leave behind (a run
 * record). The scheduler is in `apps/server/src/automation`.
 */

/** An IANA time zone, like Europe/Berlin. Without one, schedules use UTC. */
export const DEFAULT_TIME_ZONE = "UTC";

export const AutomationTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isTimeZone, { message: "Use an IANA time zone like Europe/Berlin" });

export const IntervalUnitSchema = z.enum(["minutes", "hours", "days"]);
export type IntervalUnit = z.infer<typeof IntervalUnitSchema>;

/** Every N minutes, hours or days, counted from the last run. */
export const IntervalSpecSchema = z.object({
  kind: z.literal("interval"),
  every: z.number().int().min(1).max(10_000),
  unit: IntervalUnitSchema,
});

/** Five fields, read in the schedule's time zone. */
export const CronSpecSchema = z.object({
  kind: z.literal("cron"),
  expression: z
    .string()
    .trim()
    .max(200)
    .superRefine((value, ctx) => {
      const problem = cronProblem(value);
      if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
    }),
});

/**
 * One run. `at` is `YYYY-MM-DDTHH:mm` on the wall clock of the schedule's time zone, or a full
 * time with `Z` or an offset.
 */
export const OnceSpecSchema = z.object({
  kind: z.literal("once"),
  at: z.string().trim().min(1).max(40),
});

export const ScheduleSpecSchema = z.discriminatedUnion("kind", [
  IntervalSpecSchema,
  CronSpecSchema,
  OnceSpecSchema,
]);
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;

/** `skip`: a run is skipped while the last one still goes. `allow`: runs may overlap. */
export const OverlapPolicySchema = z.enum(["skip", "allow"]);
export type OverlapPolicy = z.infer<typeof OverlapPolicySchema>;

// ---------------------------------------------------------------------------
// Actions

/** Starts a new task. The project is named in the text so the task parser finds it. */
export const TaskStartActionSchema = z.object({
  kind: z.literal("task.start"),
  project: IdSchema,
  /** Without one, majhi picks the org's default agent as it does for a new task. */
  agent: IdSchema.optional(),
  /** The whole team, lead first. Overrides `agent`. */
  team: z.array(IdSchema).min(1).max(12).optional(),
  title: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(20_000),
});

/** Posts text to an existing task's room, from "scheduler". The task's lead reads it. */
export const RoomPostActionSchema = z.object({
  kind: z.literal("room.post"),
  task: TaskIdSchema,
  text: z.string().trim().min(1).max(20_000),
});

/** Runs a command in an existing task, as `majhi-processes` does. */
export const ProcessRunActionSchema = z.object({
  kind: z.literal("process.run"),
  task: TaskIdSchema,
  command: z.string().trim().min(1).max(4_000),
  name: z.string().trim().min(1).max(80).optional(),
  /** Inside the task folder. Relative paths start there. */
  cwd: z.string().trim().min(1).max(1_000).optional(),
});

export const AutomationActionSchema = z.discriminatedUnion("kind", [
  TaskStartActionSchema,
  RoomPostActionSchema,
  ProcessRunActionSchema,
]);
export type AutomationAction = z.infer<typeof AutomationActionSchema>;

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What an action does, in one plain line. */
export function describeAutomationAction(action: AutomationAction): string {
  switch (action.kind) {
    case "task.start":
      return `Start a task in ${action.project}: ${clip(action.title, 60)}`;
    case "room.post":
      return `Post to ${action.task}: ${clip(action.text, 60)}`;
    case "process.run":
      return `Run ${clip(action.command, 50)} in ${action.task}`;
  }
}

// ---------------------------------------------------------------------------
// Run records

/**
 * `schedule`: a clock playbook (its id is the playbook's id; schedules were folded into Playbooks).
 * `watch`: a Watch whose "When it fires" runs an action. `trigger`: an old event trigger.
 */
export const AutomationSourceKindSchema = z.enum(["schedule", "trigger", "watch"]);
export type AutomationSourceKind = z.infer<typeof AutomationSourceKindSchema>;

/** `running` while what the run started still goes (see `overlap`). `skipped` ran nothing: `detail` says why. */
export const AutomationRunStatusSchema = z.enum(["running", "ok", "failed", "skipped"]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

export const AutomationRunSchema = z.object({
  id: z.number().int().positive(),
  sourceKind: AutomationSourceKindSchema,
  sourceId: z.string(),
  org: IdSchema,
  /** UTC, ISO 8601. */
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: AutomationRunStatusSchema,
  /** One plain line: what ran, what failed or why it was skipped. */
  detail: z.string(),
  /** The task a `task.start` run created. */
  taskId: z.string().nullable(),
  /** The process a `process.run` run started, in its task. */
  processId: z.string().nullable(),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

// ---------------------------------------------------------------------------
// Schedules

/** A schedule is a clock playbook: `sch-` for the ones that were schedules, `custom-` for new ones. */
export const ScheduleIdSchema = z
  .string()
  .regex(/^(?:sch|custom)-[a-z0-9][a-z0-9-]{3,60}$/, "Not a schedule id");

export const ScheduleViewSchema = z.object({
  id: ScheduleIdSchema,
  org: IdSchema,
  name: z.string(),
  spec: ScheduleSpecSchema,
  /** What `spec` is read in. */
  timeZone: z.string(),
  action: AutomationActionSchema,
  overlap: OverlapPolicySchema,
  paused: z.boolean(),
  /** A `once` schedule that has run. It is kept for its history and never runs again. */
  done: z.boolean(),
  /** UTC, ISO 8601. Null when paused or done. */
  nextRunAt: z.string().nullable(),
  /** The last run, with its outcome. */
  lastRun: AutomationRunSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduleView = z.infer<typeof ScheduleViewSchema>;

/** What a caller sets when it makes a schedule. Give `spec` or a `phrase` ("weekdays at 9:00"), not both. */
const WhenFields = {
  spec: ScheduleSpecSchema.optional(),
  /** Plain words that read as a spec: "every 30 minutes", "daily at 18:30", "mondays at 9:00". */
  phrase: z.string().trim().min(1).max(200).optional(),
  /** The caller's own zone; the UI sends the browser's. Default UTC. */
  timeZone: AutomationTimeZoneSchema.optional(),
};

export const ScheduleCreateInputSchema = z
  .object({
    org: IdSchema,
    name: z.string().trim().min(1).max(60),
    ...WhenFields,
    action: AutomationActionSchema,
    overlap: OverlapPolicySchema.default("skip"),
  })
  .refine((v) => (v.spec === undefined) !== (v.phrase === undefined), {
    message: "Give a spec or a phrase, not both",
    path: ["spec"],
  });
export type ScheduleCreateInput = z.output<typeof ScheduleCreateInputSchema>;

export const ScheduleUpdateInputSchema = z
  .object({
    id: ScheduleIdSchema,
    name: z.string().trim().min(1).max(60).optional(),
    ...WhenFields,
    action: AutomationActionSchema.optional(),
    overlap: OverlapPolicySchema.optional(),
  })
  .refine((v) => v.spec === undefined || v.phrase === undefined, {
    message: "Give a spec or a phrase, not both",
    path: ["spec"],
  });
export type ScheduleUpdateInput = z.output<typeof ScheduleUpdateInputSchema>;

// ---------------------------------------------------------------------------
// Phrases

export type PhraseResult = { ok: true; spec: ScheduleSpec } | { ok: false; error: string };

const PHRASE_HELP =
  'Try "every 30 minutes", "every 2 hours", "daily at 18:30", "weekdays at 9:00" or "mondays at 9:00"';

const DAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const UNITS: Record<string, IntervalUnit> = {
  m: "minutes",
  min: "minutes",
  mins: "minutes",
  minute: "minutes",
  minutes: "minutes",
  h: "hours",
  hr: "hours",
  hrs: "hours",
  hour: "hours",
  hours: "hours",
  d: "days",
  day: "days",
  days: "days",
};

const fail = (error: string): PhraseResult => ({ ok: false, error });
const cron = (expression: string): PhraseResult => ({ ok: true, spec: { kind: "cron", expression } });

/** `9:00`, `09:00`, `18:30`, `9am`, `6:30 pm`. */
function parseClock(text: string): { hour: number; minute: number } | string {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text.trim());
  if (m === null) return `"${text.trim()}" is not a time. Use 9:00, 18:30 or 6pm`;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3];
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12)
      return `"${text.trim()}" is not a time: the hour must be 1 to 12 with am or pm`;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return `"${text.trim()}" is not a time: the clock goes to 23:59`;
  return { hour, minute };
}

/**
 * Reads plain words as an interval or cron spec. The time zone is not part of a phrase: the
 * schedule carries it. A cron expression of five fields passes through. Pure, so the UI can use it
 * to preview.
 */
export function parseSchedulePhrase(input: string): PhraseResult {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (text === "") return fail(`Say when it runs. ${PHRASE_HELP}`);

  if (/^[\d*/,\-?]+( [\d*/,\-?]+){2}( [\d*/,\-?a-z#]+){2}$/.test(text)) {
    const problem = cronProblem(text);
    if (problem !== undefined) return fail(problem);
    return cron(text);
  }

  if (text === "hourly") return { ok: true, spec: { kind: "interval", every: 1, unit: "hours" } };

  const every = /^every (?:(\d+) ?)?([a-z]+)$/.exec(text);
  if (every !== null) {
    const unit = UNITS[every[2] ?? ""];
    if (unit !== undefined) {
      const count = every[1] === undefined ? 1 : Number(every[1]);
      if (count < 1) return fail("The interval must be at least 1");
      if (count > 10_000) return fail("The interval is too long");
      return { ok: true, spec: { kind: "interval", every: count, unit } };
    }
  }

  const at = /^(?:every )?(.+?) at (.+)$/.exec(text);
  if (at !== null) {
    const when = (at[1] ?? "").replace(/^on /, "");
    const clock = parseClock(at[2] ?? "");
    if (typeof clock === "string") return fail(clock);
    const time = `${clock.minute} ${clock.hour}`;
    if (when === "day" || when === "daily") return cron(`${time} * * *`);
    if (when === "weekday" || when === "weekdays") return cron(`${time} * * 1-5`);
    if (when === "weekend" || when === "weekends") return cron(`${time} * * 0,6`);
    const days = when.split(/ ?(?:,|and) ?| /).filter((d) => d !== "");
    const numbers: number[] = [];
    for (const word of days) {
      const day =
        DAYS[word.endsWith("s") && DAYS[word.slice(0, -1)] !== undefined ? word.slice(0, -1) : word];
      if (day === undefined) return fail(`"${word}" is not a day. ${PHRASE_HELP}`);
      if (!numbers.includes(day)) numbers.push(day);
    }
    if (numbers.length === 0) return fail(`Say which days. ${PHRASE_HELP}`);
    return cron(`${time} * * ${numbers.sort((a, b) => a - b).join(",")}`);
  }

  if (text === "daily" || text === "every day") return fail('Add a time: "daily at 18:30"');
  return fail(`I could not read "${input.trim()}". ${PHRASE_HELP}`);
}

/**
 * The spec a create or update means, from `spec` or `phrase`. Checks a `once` time against the
 * zone. Throws nothing: the problem comes back as text.
 */
export function resolveSpec(
  given: { spec?: ScheduleSpec | undefined; phrase?: string | undefined },
  timeZone: string,
): { ok: true; spec: ScheduleSpec } | { ok: false; error: string } {
  let spec = given.spec;
  if (spec === undefined) {
    const parsed = parseSchedulePhrase(given.phrase ?? "");
    if (!parsed.ok) return parsed;
    spec = parsed.spec;
  }
  if (spec.kind === "once" && onceInstant(spec.at, timeZone) === undefined) {
    return {
      ok: false,
      error: `"${spec.at}" is not a time. Use 2026-10-02T09:00 or a full time with Z or an offset`,
    };
  }
  return { ok: true, spec };
}
