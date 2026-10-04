import { z } from "zod";
import { AuthoritySchema } from "./authority.ts";
import { ChoreCapsSchema } from "./chores.ts";
import { ContainerCpusSchema, ContainerMemorySchema, ImageRefSchema } from "./containers.ts";
import { E2eSettingsSchema } from "./e2e.ts";
import { NotifyKindSchema } from "./notify.ts";

/**
 * Runtime settings in majhi.yaml that the owner or the captain can change live
 * (SPEC 5.7, 5.13, 5.16, 5.17). Every field has a default, so an empty
 * section means "use the defaults".
 */

/** Smallest context cap that makes sense: below this a session cannot hold its own brief. */
export const MIN_CONTEXT_CAP = 20_000;

/** Context budget (5.13). Orgs and agents can override `compact_at` and `cap`. */
const contextFields = {
  /**
   * Most tokens a session may use, whatever the model's window allows. 0 means no cap: the
   * model's full window. `compact_at` and `compact_target` are shares of the cap.
   */
  cap: z
    .number()
    .int()
    .refine(
      (n) => n === 0 || n >= MIN_CONTEXT_CAP,
      `Use 0 for no cap, or at least ${MIN_CONTEXT_CAP} tokens`,
    ),
  /** Compact when used / size reaches this. */
  compact_at: z.number().gt(0).lt(1),
  /** Native compaction must bring usage under this, else majhi hands off to a fresh session. */
  compact_target: z.number().gt(0).lt(1),
  /** Replace the session with a fresh one after this many turns. 0 turns it off. */
  max_turns: z.number().int().min(0),
};
export const ContextSettingsSchema = z.strictObject({
  cap: contextFields.cap.default(200_000),
  compact_at: contextFields.compact_at.default(0.8),
  compact_target: contextFields.compact_target.default(0.4),
  max_turns: contextFields.max_turns.default(40),
});
export type ContextSettings = z.infer<typeof ContextSettingsSchema>;
/**
 * Only the fields that are set. Zod 4 fills defaults inside `.partial()`, so a patch or a
 * majhi.yaml section is its own schema without defaults: an absent field stays absent.
 */
export const ContextPatchSchema = z.strictObject(contextFields).partial();

/** A duration like `10m`, `90s`, `2h`. */
export const DurationSchema = z
  .string()
  .regex(/^[1-9][0-9]*(s|m|h)$/, "Use a number and s, m or h, like 10m");

export function durationMs(value: string): number {
  const n = Number(value.slice(0, -1));
  const unit = value.at(-1);
  return n * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000);
}

/** Concurrency and idle limits (5.17). */
const limitsFields = {
  /** Agent processes running at once, across majhi. */
  agents_max: z.number().int().min(1).max(64),
  /** Agent runs at once on the whole machine, helpers included. Unset: a share of the CPU cores. */
  runs_total: z.number().int().min(1).max(64),
  /** Agent processes running at once on one account. */
  per_account: z.number().int().min(1).max(16),
  /** Agent processes running at once in one task. */
  per_task: z.number().int().min(1).max(16),
  /** Stop an idle agent process after this long; it resumes on the next message. */
  idle_timeout: DurationSchema,
};
export const LimitsSettingsSchema = z.strictObject({
  agents_max: limitsFields.agents_max.default(6),
  runs_total: limitsFields.runs_total.optional(),
  per_account: limitsFields.per_account.default(2),
  per_task: limitsFields.per_task.default(3),
  idle_timeout: limitsFields.idle_timeout.default("3m"),
});
export type LimitsSettings = z.infer<typeof LimitsSettingsSchema>;
export const LimitsPatchSchema = z.strictObject(limitsFields).partial();

/** A duration, or `off`. */
const DurationOrOffSchema = z.union([DurationSchema, z.literal("off")]);

/**
 * Turn limits (PRV-96): a turn that runs too long, goes quiet or makes too many tool calls is
 * cancelled and continues in a fresh session with a handoff note. Orgs and agents override each
 * field. `off`, or 0 tool calls, turns a limit off.
 */
const turnsFields = {
  /** The longest a turn may run. */
  max_length: DurationOrOffSchema,
  /** How long a turn may go without output or tool activity. */
  idle: DurationOrOffSchema,
  /** Tool calls in one turn. 0 turns it off. */
  max_tool_calls: z.number().int().min(0).max(100_000),
};
export const TurnsSettingsSchema = z.strictObject({
  max_length: turnsFields.max_length.default("2h"),
  idle: turnsFields.idle.default("25m"),
  max_tool_calls: turnsFields.max_tool_calls.default(0),
});
export type TurnsSettings = z.infer<typeof TurnsSettingsSchema>;
export const TurnsPatchSchema = z.strictObject(turnsFields).partial();
export type TurnsPatch = z.infer<typeof TurnsPatchSchema>;

/** Resume after sleep, restarts, lost internet and crashes (5.7). */
export const ResumeSettingsSchema = z.strictObject({
  /** Resume interrupted runs on their own. Orgs can turn it off. */
  auto: z.boolean().default(true),
  /** When an agent's account hits its limit, its fallback agent takes over (5.7). Orgs can turn it off. */
  handoff: z.boolean().default(true),
});
export type ResumeSettings = z.infer<typeof ResumeSettingsSchema>;
export const ResumePatchSchema = z.strictObject({ auto: z.boolean(), handoff: z.boolean() }).partial();

/**
 * Who a commit is attributed to (5.7): the agent as committer and a `Majhi-Task` trailer. On unless
 * turned off here, for an org or for a project; the project wins, then the org, then this.
 * A change applies to runs launched after it. Checkpoints follow it at once.
 */
export const CommitsSettingsSchema = z.strictObject({
  attribution: z.boolean().default(true),
});
export type CommitsSettings = z.infer<typeof CommitsSettingsSchema>;
export const CommitsPatchSchema = z.strictObject({ attribution: z.boolean() }).partial();
export type CommitsPatch = z.infer<typeof CommitsPatchSchema>;

/** Teams in a room (5.3). Orgs can override `max_agent_turns`. */
const roomFields = {
  /** Agent-to-agent turns without an owner message before the task pauses and asks (loop guard). */
  max_agent_turns: z.number().int().min(1).max(200),
  /** Rounds of the build and review loop before it stops and asks the owner. */
  review_rounds: z.number().int().min(1).max(50),
};
export const RoomSettingsSchema = z.strictObject({
  max_agent_turns: roomFields.max_agent_turns.default(12),
  review_rounds: roomFields.review_rounds.default(5),
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;
export const RoomPatchSchema = z.strictObject(roomFields).partial();

/** Cleanup of done tasks. */
const cleanupFields = {
  /** Tasks done for longer than this many days are offered for cleanup. */
  after_days: z.number().int().min(1).max(3650),
  /** Dependency folders and build output of tasks done for longer than this many hours are deleted. */
  free_after_hours: z.number().int().min(1).max(8760),
  /** The whole worktree of a clean, merged or pushed task done this many days is removed. 0 is off. */
  worktree_after_days: z.number().int().min(0).max(3650),
};
export const CleanupSettingsSchema = z.strictObject({
  after_days: cleanupFields.after_days.default(30),
  free_after_hours: cleanupFields.free_after_hours.default(24),
  worktree_after_days: cleanupFields.worktree_after_days.default(7),
});
export type CleanupSettings = z.infer<typeof CleanupSettingsSchema>;
export const CleanupPatchSchema = z.strictObject(cleanupFields).partial();

/** Memory curation (5.6). */
const memoryFields = {
  /**
   * The lift over chance ((n*p-1)/(n-1), 0 a guess, 1 certain) an answer needs, on top of the
   * decisions gate, before a fact is kept or dropped without the owner. Stricter than the gate.
   */
  auto_threshold: z.number().min(0).max(1),
  /** Nothing is kept or dropped on its own: every fact waits for the owner. */
  review_all: z.boolean(),
  /** The agent that reads the room after a task. Default: the captain. */
  // Same shape as an agent id; accounts.ts imports this file, so it is not imported here.
  housekeeper: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use an agent id"),
  /** The model it runs on. Default: the cheapest its account offers. */
  housekeeper_model: z.string().trim().min(1).max(100),
  /** A chat that has had no message for this long is read for memory. */
  chat_idle_minutes: z.number().int().min(1).max(1440),
};
export const MemorySettingsSchema = z.strictObject({
  auto_threshold: memoryFields.auto_threshold.default(0.4),
  review_all: memoryFields.review_all.default(false),
  housekeeper: memoryFields.housekeeper.optional(),
  housekeeper_model: memoryFields.housekeeper_model.optional(),
  chat_idle_minutes: memoryFields.chat_idle_minutes.default(30),
});
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;
/** `null` puts the default back: the captain as Housekeeper, the cheapest model. */
export const MemoryPatchSchema = z
  .strictObject({
    ...memoryFields,
    housekeeper: memoryFields.housekeeper.nullable(),
    housekeeper_model: memoryFields.housekeeper_model.nullable(),
  })
  .partial();
export type MemoryPatch = z.infer<typeof MemoryPatchSchema>;

/** The owner's editor (SPEC 11). The host helper opens files and folders in it. */
export const EditorAppSchema = z.enum(["vscode", "cursor"]);
export type EditorApp = z.infer<typeof EditorAppSchema>;
export const EDITOR_LABEL: Record<EditorApp, string> = { vscode: "VS Code", cursor: "Cursor" };

const editorFields = { app: EditorAppSchema };
export const EditorSettingsSchema = z.strictObject({ app: editorFields.app.default("vscode") });
export type EditorSettings = z.infer<typeof EditorSettingsSchema>;
export const EditorPatchSchema = z.strictObject(editorFields).partial();
/**
 * Weekly budgets (5.17, PRV-40): `budgets.orgs.<org>` and `budgets.accounts.<account>`, each a token
 * and/or a cost (USD) cap for the week from Monday in the owner's time zone. majhi alerts at 80% and
 * 100%. Tokens are input + output + cache write; cache reads are left out, and reasoning is already
 * part of output. With both set, the one further along counts.
 */
const BUDGET_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BudgetIdSchema = z.string().regex(BUDGET_ID, "Use an org or account id");
const budgetFields = {
  tokens: z.number().int().min(1).max(1e12),
  cost: z.number().positive().max(1e7),
};
export const BudgetSchema = z
  .strictObject({ tokens: budgetFields.tokens.optional(), cost: budgetFields.cost.optional() })
  .refine((b) => b.tokens !== undefined || b.cost !== undefined, {
    message: "A budget needs tokens, cost or both",
  });
export type Budget = z.infer<typeof BudgetSchema>;
export const BudgetsSettingsSchema = z.strictObject({
  orgs: z.record(BudgetIdSchema, BudgetSchema).default({}),
  accounts: z.record(BudgetIdSchema, BudgetSchema).default({}),
});
export type BudgetsSettings = z.infer<typeof BudgetsSettingsSchema>;
/** What majhi.yaml holds and what majhi writes: a section's whole map, or nothing. */
export const BudgetsFilePatchSchema = z
  .strictObject({
    orgs: z.record(BudgetIdSchema, BudgetSchema),
    accounts: z.record(BudgetIdSchema, BudgetSchema),
  })
  .partial();
/** What `settings.set` accepts: only the budgets to change; `null` removes one. The rest stay. */
export const BudgetsPatchSchema = z
  .strictObject({
    orgs: z.record(BudgetIdSchema, BudgetSchema.nullable()),
    accounts: z.record(BudgetIdSchema, BudgetSchema.nullable()),
  })
  .partial();
export type BudgetsPatch = z.infer<typeof BudgetsPatchSchema>;
/**
 * Notifications when something needs the owner: a desktop banner through the host helper, and a
 * browser notification in an open tab. `mac` turns the desktop banner on or off on every OS; it keeps
 * its first name because majhi.yaml files have it. `muted` lists the kinds that stay quiet. Quiet
 * hours hold every notification between `quiet_from` and `quiet_to` (24 h clock, in `quiet_tz`).
 */
const ClockSchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "Use a time like 22:00");
const notificationsFields = {
  mac: z.boolean(),
  browser: z.boolean(),
  sound: z.boolean(),
  muted: z.array(NotifyKindSchema).max(NotifyKindSchema.options.length),
  quiet_from: ClockSchema,
  quiet_to: ClockSchema,
  /** An IANA zone like Europe/Berlin: the browser that saved the hours knows it, the server may not. */
  quiet_tz: z.string().trim().min(1).max(64),
};
export const NotificationsSettingsSchema = z.strictObject({
  mac: notificationsFields.mac.default(true),
  browser: notificationsFields.browser.default(true),
  sound: notificationsFields.sound.default(false),
  muted: notificationsFields.muted.default([]),
  quiet_from: notificationsFields.quiet_from.optional(),
  quiet_to: notificationsFields.quiet_to.optional(),
  quiet_tz: notificationsFields.quiet_tz.optional(),
});
export type NotificationsSettings = z.infer<typeof NotificationsSettingsSchema>;
/** `null` clears the quiet hours. */
export const NotificationsPatchSchema = z
  .strictObject({
    ...notificationsFields,
    quiet_from: notificationsFields.quiet_from.nullable(),
    quiet_to: notificationsFields.quiet_to.nullable(),
    quiet_tz: notificationsFields.quiet_tz.nullable(),
  })
  .partial();
export type NotificationsPatch = z.infer<typeof NotificationsPatchSchema>;
/** What majhi.yaml may hold. */
export const NotificationsFilePatchSchema = z.strictObject(notificationsFields).partial();

/** Containers majhi runs for agents: previews and test services (PRV-53). */
const containersFields = {
  /** Service images the owner allowed. Changed only by `containers.images.allow` and `.remove`. */
  images: z.array(ImageRefSchema).max(100),
  /** CPUs per preview or service container. */
  cpus: ContainerCpusSchema,
  /** Memory per preview or service container. */
  memory: ContainerMemorySchema,
  /** Previews and services running at once in one task. */
  per_task: z.number().int().min(1).max(10),
  /** Previews and services running across all tasks. */
  total: z.number().int().min(1).max(100),
  /** Preview builds running across all tasks. */
  build_total: z.number().int().min(1).max(10),
  /** CPUs of the preview builder. */
  build_cpus: ContainerCpusSchema,
  /** Memory of the preview builder. */
  build_memory: ContainerMemorySchema,
  /** CPUs of a hand-off check (tests, build, lint of a finished task). Unset: half the machine's cores, at least 2. */
  handoff_cpus: ContainerCpusSchema,
  /** Memory of a hand-off check. Unset: 4g. */
  handoff_memory: ContainerMemorySchema,
  /** Minutes a project's hand-off tests and build may run before they are stopped, by project. A project left out gets 10. */
  handoff_minutes: z.record(z.string(), z.number().int().min(1).max(240)),
};
export const ContainersSettingsSchema = z.strictObject({
  images: containersFields.images.default([]),
  cpus: containersFields.cpus.default(1),
  memory: containersFields.memory.default("512m"),
  per_task: containersFields.per_task.default(3),
  total: containersFields.total.default(8),
  build_total: containersFields.build_total.default(1),
  build_cpus: containersFields.build_cpus.default(2),
  build_memory: containersFields.build_memory.default("4g"),
  handoff_cpus: containersFields.handoff_cpus.optional(),
  handoff_memory: containersFields.handoff_memory.optional(),
  handoff_minutes: containersFields.handoff_minutes.optional(),
});
export type ContainersSettings = z.infer<typeof ContainersSettingsSchema>;
/** What majhi.yaml may hold and what majhi writes: the limits and the image list. */
export const ContainersFilePatchSchema = z.strictObject(containersFields).partial();
/** What `settings.set` accepts: the limits, never `images`, so every new image goes through its own card. */
export const ContainersPatchSchema = ContainersFilePatchSchema.omit({ images: true });
export type ContainersPatch = z.infer<typeof ContainersPatchSchema>;

/** How the captain's commands are approved, per risk class (5.16). */
export const ApprovalModeSchema = z.enum([
  /** Runs without asking. */
  "auto",
  /** Runs when the owner asked for it in the conversation; otherwise waits for a click. */
  "when-asked",
  /** Always waits for the owner's click. */
  "confirm",
]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

const RULE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * "Always allow this agent to run this command", saved when the owner ticks the box on an approval
 * card. It has exactly one scope: a `task` (only that task) or an `org` (every task in that org).
 * It only turns a card that would wait into one that runs, and never blocks anything.
 */
export const AllowRuleSchema = z
  .strictObject({
    agent: z.string().regex(RULE_ID),
    command: z.string().min(1),
    task: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/)
      .optional(),
    org: z.string().regex(RULE_ID).optional(),
  })
  .refine((rule) => (rule.task === undefined) !== (rule.org === undefined), {
    message: "A rule has exactly one of task or org",
  });
export type AllowRule = z.infer<typeof AllowRuleSchema>;

export const PolicySettingsSchema = z.strictObject({
  read: ApprovalModeSchema.default("auto"),
  change: ApprovalModeSchema.default("when-asked"),
  destructive: ApprovalModeSchema.default("confirm"),
  outbound: ApprovalModeSchema.default("confirm"),
  /** Per-command overrides, by command name. */
  commands: z.record(z.string(), ApprovalModeSchema).default({}),
  /** Saved "always allow" choices from approval cards. */
  rules: z.array(AllowRuleSchema).default([]),
  /**
   * No longer read: a destructive command always waits for the owner's click. Kept so a majhi.yaml
   * that still sets it loads.
   */
  allow_destructive_rules: z.boolean().default(false),
});
export type PolicySettings = z.infer<typeof PolicySettingsSchema>;
/** `commands` and `rules`, when given, replace the whole map or list. */
export const PolicyPatchSchema = z
  .strictObject({
    read: ApprovalModeSchema,
    change: ApprovalModeSchema,
    destructive: ApprovalModeSchema,
    outbound: ApprovalModeSchema,
    commands: z.record(z.string(), ApprovalModeSchema),
    rules: z.array(AllowRuleSchema),
  })
  .partial();
export type PolicyPatch = z.infer<typeof PolicyPatchSchema>;

/**
 * Autonomous mode (PRV-74): the caps it spends within, the account floors it keeps, what it may do
 * per org, when the daily summary is made, and the owner's standing instructions. Whether it is on
 * is runtime state (`autonomy.status`), not config. Only the owner changes this section.
 */
/**
 * How much the captain does in a workspace (SPEC 5.18): `ask` answers only when the owner talks to it,
 * `tidy` also does the upkeep chores and asks before shipping, `runs` also picks, runs and ships tasks
 * within the workspace's daily budget while autonomous mode is on. Absent: `tidy` for Private, `ask`
 * for every other workspace.
 */
export const CaptainLevelSchema = z.enum(["ask", "tidy", "runs"]);
export type CaptainLevel = z.infer<typeof CaptainLevelSchema>;

const DaySchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Use a date like 2026-12-24");
/** Days the captain does nothing on its own in the workspace, `from` to `to` inclusive, in its zone. */
export const FreezeSchema = z
  .strictObject({ from: DaySchema, to: DaySchema })
  .refine((f) => f.from <= f.to, { message: "The freeze ends before it starts" });
export type Freeze = z.infer<typeof FreezeSchema>;
/** The captain acts on its own only between `from` and `to` (24 h clock, may run over midnight). */
export const WorkHoursSchema = z
  .strictObject({ from: ClockSchema, to: ClockSchema })
  .refine((h) => h.from !== h.to, { message: "Working hours need a start and an end" });
export type WorkHours = z.infer<typeof WorkHoursSchema>;
/** A branch name the captain may ship to, like main or develop. */
const ShipBranchSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._/-]{1,200}$/, "Use a branch name like main")
  .refine((b) => !b.startsWith("-") && !b.includes(".."), "Use a branch name like main");
/** An AI tool id from the tool registry (claude, codex). Checked against the registry when saved. */
const ProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const AutonomyOrgSchema = z.strictObject({
  /** Who decides each row (SPEC 5.18). Absent: derived from `level`, `push` and `merge`, or the defaults. */
  authority: AuthoritySchema.optional(),
  /** Before the authority table: how much the captain does here. Read only while `authority` is absent. */
  level: CaptainLevelSchema.optional(),
  /** This org's cap per day (the daily budget next to the authority table). Absent: only the overall `day` cap holds it. */
  cap: BudgetSchema.optional(),
  /** Before the authority table: may push. Read only while `authority` is absent. */
  push: z.boolean().optional(),
  /** Before the authority table: may merge. Read only while `authority` is absent. */
  merge: z.boolean().optional(),
  /** "More rules": when the captain may act on its own, in `tz`. Absent: any time. */
  hours: WorkHoursSchema.optional(),
  /** "More rules": days it does nothing on its own. */
  freeze: z.array(FreezeSchema).max(50).optional(),
  /** "More rules": the workspace's time zone for hours, freezes and its day. Absent: autonomous mode's. */
  tz: z.string().trim().min(1).max(64).optional(),
  /** "More rules": the base branches it ships to. Absent: each project's own base. */
  branches: z.array(ShipBranchSchema).min(1).max(20).optional(),
  /** "More rules": the AI tools its lane and the work it starts may use. Absent: every tool. */
  providers: z.array(ProviderIdSchema).min(1).max(10).optional(),
  /** "More rules": the account that pays for the captain's decisions here. Absent: the captain's own. */
  account: z.string().regex(ACCOUNT_ID).optional(),
  /** Limits: the owner's daily caps per chore here (`null`: no cap). Absent: majhi's defaults. */
  chores: ChoreCapsSchema.optional(),
  /**
   * Full access: the captain decides every row here and its calls run without a card, except a change
   * to anyone's permissions and anything destructive. Only the owner sets it.
   */
  fullAccess: z.boolean().optional(),
  /** How many tasks the captain keeps working at once in this workspace. Absent: 1. */
  tasksAtOnce: z.number().int().min(1).max(10).optional(),
});
export type AutonomyOrg = z.infer<typeof AutonomyOrgSchema>;

/** Tasks the captain works on at once in a workspace when the owner set nothing. */
export const TASKS_AT_ONCE = 1;

/** Guidance the owner gave on the Autonomous page, which the captain follows until it is removed. */
export const AutonomyInstructionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]{8}$/),
  text: z.string().trim().min(1).max(500),
  /** When the owner gave it, as a UTC ISO time. */
  at: z.string(),
  /** The workspace it was given in: only that workspace's captain follows it. Absent: every workspace. */
  org: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .optional(),
});
export type AutonomyInstruction = z.infer<typeof AutonomyInstructionSchema>;

const PercentLeftSchema = z.number().int().min(0).max(100);

/**
 * The largest task autonomous mode may start, by the size the decision provider rated it (Laya):
 * `small` (a small change in one or two files), `medium` (a feature or fix across several files) or
 * `any`. Under `small` or `medium`, a task whose size is not known is not started.
 */
export const TaskSizeLimitSchema = z.enum(["small", "medium", "any"]);
export type TaskSizeLimit = z.infer<typeof TaskSizeLimitSchema>;

/**
 * What autonomous mode may pick: the task sizes. Tasks marked `noAutonomy` are left alone, and it
 * works only in workspaces where `orgs.<org>.authority.start` is `decide`.
 */
export const AutonomyPickSchema = z.strictObject({
  size: TaskSizeLimitSchema.default("any"),
  /**
   * Before Phase 13: the orgs it could work in. Read once at start, when majhi moves the listed orgs
   * to the old "Runs it" level and removes this list. Nothing else reads it.
   */
  orgs: z.array(BudgetIdSchema).max(100).optional(),
});
export type AutonomyPick = z.infer<typeof AutonomyPickSchema>;

const autonomyFields = {
  /** Spend per day of everything autonomous mode runs, from midnight in `tz`. Always set. */
  day: BudgetSchema,
  orgs: z.record(BudgetIdSchema, AutonomyOrgSchema),
  /** No new work starts on an account with less than this share of a window left, in percent. */
  floors: z.strictObject({ window: PercentLeftSchema, weekly: PercentLeftSchema }),
  /** When the daily summary is made, 24 h clock in `tz`. */
  summary_at: ClockSchema,
  /** An IANA zone like Europe/Berlin: the browser that saved the settings knows it. Absent: the server's. */
  tz: z.string().trim().min(1).max(64),
  instructions: z.array(AutonomyInstructionSchema).max(50),
  pick: AutonomyPickSchema,
};
export const AutonomySettingsSchema = z.strictObject({
  day: autonomyFields.day.default({ cost: 20 }),
  orgs: autonomyFields.orgs.default({}),
  floors: autonomyFields.floors.default({ window: 10, weekly: 5 }),
  summary_at: autonomyFields.summary_at.default("08:00"),
  tz: autonomyFields.tz.optional(),
  instructions: autonomyFields.instructions.default([]),
  pick: autonomyFields.pick.default({ size: "any" }),
});
export type AutonomySettings = z.infer<typeof AutonomySettingsSchema>;
/**
 * One workspace's change in `autonomy.configure`: only what changes, `null` removes a field (back to
 * its default). The choice, the budget and "More rules" all change here.
 */
export const AutonomyOrgPatchSchema = z
  .strictObject({
    /** Only the rows that change. Saving writes the new form and drops the old level, push and merge. */
    authority: AuthoritySchema.partial(),
    cap: BudgetSchema.nullable(),
    hours: WorkHoursSchema.nullable(),
    freeze: z.array(FreezeSchema).max(50).nullable(),
    tz: z.string().trim().min(1).max(64).nullable(),
    branches: z.array(ShipBranchSchema).min(1).max(20).nullable(),
    providers: z.array(ProviderIdSchema).min(1).max(10).nullable(),
    account: z.string().regex(ACCOUNT_ID).nullable(),
    /** Limits: the daily caps per chore, replacing the ones set before. `null`: back to majhi's defaults. */
    chores: ChoreCapsSchema.nullable(),
    fullAccess: z.boolean().nullable(),
    tasksAtOnce: z.number().int().min(1).max(10).nullable(),
  })
  .partial();
export type AutonomyOrgPatch = z.infer<typeof AutonomyOrgPatchSchema>;
/** What majhi.yaml may hold and what majhi writes. */
export const AutonomyFilePatchSchema = z.strictObject(autonomyFields).partial();
/**
 * What `autonomy.configure` accepts: only what changes. An `orgs` entry merges into the org's
 * current one, and `null` removes it (or its `cap`). The day cap can change but never goes away.
 * Instructions change only through `autonomy.guide` and `autonomy.forget`.
 */
export const AutonomyPatchSchema = z
  .strictObject({
    day: BudgetSchema,
    orgs: z.record(BudgetIdSchema, AutonomyOrgPatchSchema.nullable()),
    floors: z.strictObject({ window: PercentLeftSchema, weekly: PercentLeftSchema }).partial(),
    summary_at: ClockSchema,
    tz: autonomyFields.tz,
    pick: z.strictObject({ size: TaskSizeLimitSchema }).partial(),
  })
  .partial();
export type AutonomyPatch = z.infer<typeof AutonomyPatchSchema>;

/** Everything in one object, as `settings.get` returns it (defaults applied). */
export const SettingsSchema = z.object({
  context: ContextSettingsSchema,
  limits: LimitsSettingsSchema,
  turns: TurnsSettingsSchema,
  resume: ResumeSettingsSchema,
  commits: CommitsSettingsSchema,
  rooms: RoomSettingsSchema,
  policy: PolicySettingsSchema,
  memory: MemorySettingsSchema,
  editor: EditorSettingsSchema,
  e2e: E2eSettingsSchema,
  cleanup: CleanupSettingsSchema,
  containers: ContainersSettingsSchema,
  budgets: BudgetsSettingsSchema,
  notifications: NotificationsSettingsSchema,
  autonomy: AutonomySettingsSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;
