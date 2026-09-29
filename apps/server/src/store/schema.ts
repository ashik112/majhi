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

export const audit = sqliteTable("audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  task: text("task").notNull(),
  agent: text("agent").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  decision: text("decision").notNull(),
  by: text("by").notNull(),
  at: text("at").notNull(),
});

export const taskAllowances = sqliteTable(
  "task_allowances",
  {
    task: text("task").notNull(),
    kind: text("kind").notNull(),
  },
  (t) => [primaryKey({ columns: [t.task, t.kind] })],
);
