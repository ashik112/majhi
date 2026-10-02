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
    pushedAt: text("pushed_at"),
    /** The branch tip majhi merged, and the branch it merged into. */
    shippedHead: text("shipped_head"),
    shippedInto: text("shipped_into"),
    /** The commit the branch was cut from. Null on tasks made before it was recorded. */
    startCommit: text("start_commit"),
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
  },
  (t) => [primaryKey({ columns: [t.task, t.id] }), uniqueIndex("room_items_seq").on(t.task, t.seq)],
);

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

/** The tasks autonomous mode runs (PRV-74). The rest of its tables are read in `autonomy/repo.ts`. */
export const autonomyTasks = sqliteTable("autonomy_tasks", {
  task: text("task").primaryKey(),
  since: text("since").notNull(),
  held: text("held"),
  heldScope: text("held_scope"),
  resumedAt: text("resumed_at"),
});
