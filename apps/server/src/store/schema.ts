import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Drizzle's view of `majhi.db`. The tables themselves are created by the
 * SQL in `migrations.ts`; keep the two in step.
 */

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  brief: text("brief").notNull(),
  kind: text("kind").notNull(),
  org: text("org"),
  status: text("status").notNull(),
  pausedReason: text("paused_reason"),
  /** `captain` or `autonomy-off` when one of them paused the task (migration 120). */
  pausedBy: text("paused_by"),
  folder: text("folder").notNull(),
  /** JSON array of agent ids. */
  team: text("team").notNull(),
  /** Start the task by itself once its dependencies are met (5.4a). */
  startWhenReady: integer("start_when_ready", { mode: "boolean" }).notNull().default(false),
  /** Coordination mode (5.3). */
  mode: text("mode").notNull().default("lead"),
  /** JSON: agent id to the owner's model, effort and repos for this task. */
  overrides: text("overrides").notNull().default("{}"),
  /** JSON: the room's turn counters (loop guard, pipeline step, review round). */
  roomState: text("room_state").notNull().default("{}"),
  /** JSON array of ReadMount: folders mounted read-only into the task's runs. */
  readMounts: text("read_mounts").notNull().default("[]"),
  /** JSON array of connection ids the task's root agents get beyond its org's (5.14). */
  connections: text("connections").notNull().default("[]"),
  /** JSON PendingShip: the ship majhi runs once the lead resolves its conflicts. NULL when none. */
  pendingShip: text("pending_ship"),
  /** The owner's priority (`high`, `low`); NULL is normal (PRV-74). */
  priority: text("priority"),
  /** The owner's deadline, `YYYY-MM-DD`; NULL for none. */
  due: text("due"),
  /** The task type and who set it (migration 176). Both set or both NULL. */
  type: text("type"),
  typeBy: text("type_by"),
  /** JSON TaskFields: what the kind holds beyond the common fields (migration 187). NULL for none. */
  fields: text("fields"),
  /** JSON StoredOrigin: where the task came from. NULL for tasks made before origins and for chats (migration 176). */
  origin: text("origin"),
  /** The owner marked it Not for autonomous mode (migration 114). */
  noAutonomy: integer("no_autonomy", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const taskRepos = sqliteTable(
  "task_repos",
  {
    task: text("task").notNull(),
    project: text("project").notNull(),
    source: text("source").notNull(),
    base: text("base").notNull(),
    branch: text("branch").notNull(),
    worktree: text("worktree"),
    createdBranch: integer("created_branch", { mode: "boolean" }).notNull(),
    pos: integer("pos").notNull(),
    /** A `ready` dependency this branch is stacked on, its branch and the commit it sits on (5.4a). */
    stackTask: text("stack_task"),
    stackBranch: text("stack_branch"),
    stackCommit: text("stack_commit"),
    /** The owner's place in the merge order; null on every repo of a task means "from project links". */
    mergeOrder: integer("merge_order"),
    mrUrl: text("mr_url"),
    mrNumber: integer("mr_number"),
    /** `open`, `merged` or `closed`. */
    mrState: text("mr_state"),
    /** `none`, `pending`, `passing` or `failing`. */
    ciState: text("ci_state"),
    /** The reviews of the MR as the host last said (JSON, `MrReview`). */
    mrReview: text("mr_review"),
    pushedAt: text("pushed_at"),
    /** The branch tip majhi merged, and the branch it merged into. */
    shippedHead: text("shipped_head"),
    shippedInto: text("shipped_into"),
    /** The commit this repo's work landed in on its base, the branch, and when (migration 177). */
    landedCommit: text("landed_commit"),
    landedInto: text("landed_into"),
    landedAt: text("landed_at"),
    /** The commit the branch was cut from. Null on tasks made before it was recorded. */
    startCommit: text("start_commit"),
    /** The ref that commit was taken from (`main` or `origin/main`). */
    startRef: text("start_ref"),
    /** A protected project the owner let agents write in, for this task. */
    writes: integer("writes", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.task, t.project] })],
);

export const taskLinks = sqliteTable(
  "task_links",
  {
    task: text("task").notNull(),
    type: text("type").notNull(),
    other: text("other").notNull(),
    when: text("when_"),
  },
  (t) => [primaryKey({ columns: [t.task, t.type, t.other] })],
);

export const attachments = sqliteTable(
  "attachments",
  {
    task: text("task").notNull(),
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    mime: text("mime"),
    size: integer("size"),
    url: text("url"),
    path: text("path"),
    error: text("error"),
    pos: integer("pos").notNull(),
  },
  (t) => [primaryKey({ columns: [t.task, t.id] })],
);

export const roomItems = sqliteTable(
  "room_items",
  {
    task: text("task").notNull(),
    id: text("id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    /** JSON of the item without `id`, `task`, `seq`, `at`. */
    payload: text("payload").notNull(),
    at: text("at").notNull(),
    /** A chat app message's key (`externalKeyText`), unique (migration 179). Null for every other item. */
    external: text("external"),
    /** 1 while the item's `state` is pending, read from the payload (virtual column, migration 153). */
    pending: integer("pending").generatedAlwaysAs(
      sql`CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload, '$.state') = 'pending', 0) ELSE 0 END`,
      { mode: "virtual" },
    ),
  },
  (t) => [
    primaryKey({ columns: [t.task, t.id] }),
    uniqueIndex("room_items_seq").on(t.task, t.seq),
    index("room_items_task_type_at").on(t.task, t.type, t.at),
  ],
);

/** The owner's read state per conversation (migration 158): the `at` of the newest message seen. */
export const readMarks = sqliteTable("read_marks", {
  id: text("id").primaryKey(),
  readAt: text("read_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Conversations the owner archived (migration 182): hidden from the list, history kept. */
export const conversationArchive = sqliteTable("conversation_archive", {
  id: text("id").primaryKey(),
  archivedAt: text("archived_at").notNull(),
});

export const runs = sqliteTable(
  "runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    task: text("task").notNull(),
    agent: text("agent").notNull(),
    sessionId: text("session_id"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    stopReason: text("stop_reason"),
    model: text("model"),
    effort: text("effort"),
    /** The MCP servers this run attached, a JSON array of names. Null for runs made before it was recorded. */
    tools: text("tools"),
    /** The skills this run had at launch, a JSON array of names. Null for runs made before it was recorded. */
    skills: text("skills"),
    /** 1 while a turn runs, and after a turn was cut (crash, shutdown, offline) until it continues. */
    inFlight: integer("in_flight").notNull().default(0),
    /** The last checkpoint number this run committed, 0 for none. */
    checkpoint: integer("checkpoint").notNull().default(0),
    /** The room position at that checkpoint. */
    roomSeq: integer("room_seq").notNull().default(0),
    /** The decision that picked the model or effort, for `auto` agents. */
    decisionId: text("decision_id"),
  },
  (t) => [index("runs_task_agent").on(t.task, t.agent)],
);

/** Each time an agent used a skill, once per tool call. */
export const skillUses = sqliteTable(
  "skill_uses",
  {
    run: integer("run")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    skill: text("skill").notNull(),
    at: text("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.run, t.toolCallId] }), index("skill_uses_skill_at").on(t.skill, t.at)],
);

export const taskCounters = sqliteTable("task_counters", {
  prefix: text("prefix").primaryKey(),
  /** The last number handed out. */
  last: integer("last").notNull(),
});

export const audit = sqliteTable(
  "audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    task: text("task").notNull(),
    agent: text("agent").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    decision: text("decision").notNull(),
    by: text("by").notNull(),
    at: text("at").notNull(),
    /** The task's org when the row was written. Null only for a row of a task that was already gone. */
    org: text("org"),
    /** The target branch, the MR link or the error. */
    detail: text("detail"),
  },
  (t) => [index("audit_at").on(t.at), index("audit_org_at").on(t.org, t.at)],
);

export const taskAllowances = sqliteTable(
  "task_allowances",
  {
    task: text("task").notNull(),
    kind: text("kind").notNull(),
  },
  (t) => [primaryKey({ columns: [t.task, t.kind] })],
);

export const taskPlans = sqliteTable(
  "task_plans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    task: text("task").notNull(),
    org: text("org"),
    version: integer("version").notNull(),
    at: text("at").notNull(),
    agent: text("agent").notNull(),
    /** JSON: the plan as `TeamPlanSchema` has it. */
    plan: text("plan").notNull(),
    /** JSON: the team when the plan was recorded, `PlanMemberSchema[]`. */
    team: text("team").notNull(),
    /** JSON: `PlanOutcomeSchema`, null until the task reached review or done. */
    outcome: text("outcome"),
  },
  (t) => [index("task_plans_task_version").on(t.task, t.version), index("task_plans_org_at").on(t.org, t.at)],
);

/** The captain's action keys (migration 151): one row per state a ship, an answer or a tell acted on. */
export const captainKeys = sqliteTable(
  "captain_keys",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull(),
    task: text("task"),
    at: text("at").notNull(),
    /** 0 while the action runs, 1 once it ran. */
    settled: integer("settled").notNull().default(0),
  },
  (t) => [index("captain_keys_task").on(t.task)],
);

/** The loop guard's count of captain answers per task since its last progress (migration 152). */
export const captainLoopGuard = sqliteTable("captain_loop_guard", {
  task: text("task").primaryKey(),
  mark: text("mark").notNull(),
  answers: integer("answers").notNull(),
  paused: integer("paused").notNull().default(0),
});

/** The lifecycle audit trail and outbox (migration 156). Written only by `tasks/lifecycle/rows.ts`. */
export const taskEvents = sqliteTable(
  "task_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    task: text("task").notNull(),
    at: text("at").notNull(),
    event: text("event").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    fromHold: text("from_hold"),
    hold: text("hold"),
    actor: text("actor").notNull(),
    refused: integer("refused", { mode: "boolean" }).notNull().default(false),
    code: text("code"),
    text: text("text"),
    /** JSON list of the effects still to run (the outbox). NULL once they ran. */
    pendingEffects: text("pending_effects"),
  },
  (t) => [index("task_events_task").on(t.task, t.id)],
);

/** The tasks autonomous mode runs (PRV-74). The rest of its tables are read in `autonomy/repo.ts`. */
export const autonomyTasks = sqliteTable("autonomy_tasks", {
  task: text("task").primaryKey(),
  since: text("since").notNull(),
  held: text("held"),
  heldScope: text("held_scope"),
  resumedAt: text("resumed_at"),
  why: text("why"),
});
