import type Database from "better-sqlite3";

export interface Migration {
  /** Increasing, never reused. */
  id: number;
  name: string;
  sql: string;
}

/** The item types the room search indexes, as an SQL list (see SEARCHABLE_ITEM_TYPES in shared). */
const SEARCHABLE = "'owner', 'agent', 'handoff', 'system', 'tool'";

/**
 * SQL for the text of a room item in `row` (a table name, or `new`): a message's text, or a tool's title and output.
 * A payload that is not JSON gives no text: json_extract would throw and abort the whole statement.
 */
function searchText(row: string): string {
  return `CASE
    WHEN NOT json_valid(${row}.payload) THEN ''
    WHEN ${row}.type = 'tool' THEN coalesce(json_extract(${row}.payload, '$.title'), '') || char(10) || coalesce(
      (SELECT group_concat(coalesce(json_extract(c.value, '$.text'), json_extract(c.value, '$.output'), json_extract(c.value, '$.newText'), ''), char(10))
       FROM json_each(${row}.payload, '$.content') AS c), '')
    ELSE coalesce(json_extract(${row}.payload, '$.text'), '')
  END`;
}

/**
 * Applied in order at startup and tracked in the `migrations` table. Never
 * edit one that shipped: add the next.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "tasks, rooms and runs",
    sql: `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  kind TEXT NOT NULL,
  org TEXT,
  status TEXT NOT NULL,
  paused_reason TEXT,
  folder TEXT NOT NULL,
  team TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_updated ON tasks (updated_at);

CREATE TABLE task_repos (
  task TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  source TEXT NOT NULL,
  base TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree TEXT,
  created_branch INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  PRIMARY KEY (task, project)
);
CREATE INDEX task_repos_project ON task_repos (project);

CREATE TABLE task_links (
  task TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  other TEXT NOT NULL,
  when_ TEXT,
  PRIMARY KEY (task, type, other)
);

CREATE TABLE attachments (
  task TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  url TEXT,
  path TEXT,
  error TEXT,
  pos INTEGER NOT NULL,
  PRIMARY KEY (task, id)
);

CREATE TABLE room_items (
  task TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (task, id)
);
CREATE UNIQUE INDEX room_items_seq ON room_items (task, seq);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  session_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  stop_reason TEXT,
  model TEXT,
  effort TEXT
);
CREATE INDEX runs_task_agent ON runs (task, agent);

CREATE TABLE task_counters (
  prefix TEXT PRIMARY KEY,
  last INTEGER NOT NULL
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  by TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX audit_task ON audit (task);

CREATE TABLE task_allowances (
  task TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  PRIMARY KEY (task, kind)
);
`,
  },
  {
    // Ids leave a gap on purpose: other Phase 2b work adds migrations at the same time.
    id: 10,
    name: "tasks start when their dependencies are met",
    sql: `
ALTER TABLE tasks ADD COLUMN start_when_ready INTEGER NOT NULL DEFAULT 0;
CREATE INDEX task_links_other ON task_links (other);
`,
  },
  {
    // Decision log (5.12). The id is well above the others so parallel work does not collide.
    id: 20,
    name: "decision log",
    sql: `
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  use TEXT NOT NULL,
  task TEXT,
  agent TEXT,
  summary TEXT NOT NULL,
  provider TEXT NOT NULL,
  answers TEXT NOT NULL,
  estimated INTEGER NOT NULL,
  duration_ms REAL NOT NULL
);
CREATE INDEX decisions_at ON decisions (at);
`,
  },
  {
    // The run manager (5.7, 5.13): what a restart needs to continue a turn, and what a run picked.
    id: 30,
    name: "checkpoints and interrupted turns on runs",
    sql: `
ALTER TABLE runs ADD COLUMN in_flight INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN checkpoint INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN room_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN decision_id TEXT;
`,
  },
  {
    // Tokens and cost (Phase 2c): one row per agent turn. Names are copied in, not referenced, so a
    // removed task, agent or account keeps its history.
    id: 40,
    name: "tokens and cost per turn",
    sql: `
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  task TEXT NOT NULL,
  agent TEXT NOT NULL,
  account TEXT NOT NULL,
  tool TEXT NOT NULL,
  auth TEXT NOT NULL,
  org TEXT,
  project TEXT,
  run_id INTEGER,
  model TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd REAL,
  cost_source TEXT NOT NULL,
  estimated INTEGER NOT NULL
);
CREATE INDEX turns_at ON turns (at);
CREATE INDEX turns_task ON turns (task);
CREATE INDEX turns_org_at ON turns (org, at);
`,
  },
  {
    // Teams in a room (Phase 3): how the team takes turns, the owner's per-task agent choices,
    // the room's turn counters, and branches stacked on a `ready` dependency.
    id: 50,
    name: "coordination modes, team overrides and stacked branches",
    sql: `
ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'lead';
ALTER TABLE tasks ADD COLUMN overrides TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN room_state TEXT NOT NULL DEFAULT '{}';
ALTER TABLE task_repos ADD COLUMN stack_task TEXT;
ALTER TABLE task_repos ADD COLUMN stack_branch TEXT;
ALTER TABLE task_repos ADD COLUMN stack_commit TEXT;
`,
  },
  {
    // Decisions kept for learning: the whole request and what the provider got (JSON), what majhi
    // did with the answer, and the owner's correction. Older rows have none of them.
    id: 60,
    name: "decision requests, outcomes and corrections",
    sql: `
ALTER TABLE decisions ADD COLUMN detail TEXT;
ALTER TABLE decisions ADD COLUMN outcome TEXT;
ALTER TABLE decisions ADD COLUMN correction TEXT;
`,
  },
  {
    // The lead's plan for a task, one row per version (PRV-52). \`team\` copies the team at plan
    // time and \`outcome\` holds the tokens each agent used under the version, read at review or
    // done. Names are copied in, as \`turns\` does, so a removed task keeps its history.
    id: 70,
    name: "plans kept on the task, with the tokens each agent used",
    sql: `
CREATE TABLE task_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  org TEXT,
  version INTEGER NOT NULL,
  at TEXT NOT NULL,
  agent TEXT NOT NULL,
  plan TEXT NOT NULL,
  team TEXT NOT NULL,
  outcome TEXT
);
CREATE INDEX task_plans_task_version ON task_plans (task, version);
CREATE INDEX task_plans_org_at ON task_plans (org, at);
`,
  },
  {
    // Multi-repo merge requests (Phase 4, SPEC 5.5): where each task repo stands in the merge
    // order, and its MR, CI and push state. Every column is empty until the owner opens MRs.
    id: 80,
    name: "merge order, MR and CI state on task repos",
    sql: `
ALTER TABLE task_repos ADD COLUMN merge_order INTEGER;
ALTER TABLE task_repos ADD COLUMN mr_url TEXT;
ALTER TABLE task_repos ADD COLUMN mr_number INTEGER;
ALTER TABLE task_repos ADD COLUMN mr_state TEXT;
ALTER TABLE task_repos ADD COLUMN ci_state TEXT;
ALTER TABLE task_repos ADD COLUMN pushed_at TEXT;
`,
  },
  {
    // Full-text search over the rooms (PRV-35). \`room_search\` holds the text of messages, handoffs,
    // system lines and tool output, one row per room item, with the item's rowid. Triggers keep it
    // in step on insert, update and delete (a task's removal cascades to its items, so it does too).
    id: 90,
    name: "full-text index over room messages and tool output",
    sql: `
CREATE VIRTUAL TABLE room_search USING fts5 (text, tokenize = 'porter unicode61');

CREATE TRIGGER room_search_insert AFTER INSERT ON room_items
WHEN new.type IN (${SEARCHABLE})
BEGIN
  INSERT INTO room_search (rowid, text) VALUES (new.rowid, ${searchText("new")});
END;

CREATE TRIGGER room_search_update AFTER UPDATE ON room_items
BEGIN
  DELETE FROM room_search WHERE rowid = old.rowid;
  INSERT INTO room_search (rowid, text) SELECT new.rowid, ${searchText("new")} WHERE new.type IN (${SEARCHABLE});
END;

CREATE TRIGGER room_search_delete AFTER DELETE ON room_items
BEGIN
  DELETE FROM room_search WHERE rowid = old.rowid;
END;

INSERT INTO room_search (rowid, text)
SELECT rowid, ${searchText("room_items")} FROM room_items WHERE type IN (${SEARCHABLE});
`,
  },
  {
    // A ship that stopped on conflicts and waits for the lead to resolve them (JSON, a
    // PendingShip). Existing rows get NULL: nothing pending.
    id: 100,
    name: "ship waiting for the lead to resolve conflicts",
    sql: `
ALTER TABLE tasks ADD COLUMN pending_ship TEXT;
`,
  },
  {
    // Schedules and their run history (PRV-63). `automation_runs` is shared with watch triggers:
    // `source_kind` and `source_id` say which schedule or trigger a run belongs to. Times are UTC ISO.
    // `task_id` is the task a run created, or the task a process runs in; `process_id` is that process.
    id: 101,
    name: "schedules and automation runs",
    sql: `
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  action TEXT NOT NULL,
  overlap TEXT NOT NULL DEFAULT 'skip',
  paused INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  last_run_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX schedules_org ON schedules (org);
CREATE INDEX schedules_next_run ON schedules (next_run_at);
CREATE TABLE automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  org TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  process_id TEXT
);
CREATE INDEX automation_runs_source ON automation_runs (source_kind, source_id, id);
CREATE INDEX automation_runs_status ON automation_runs (status);
`,
  },
  {
    // Watch triggers (PRV-63). `baseline` is what the trigger last saw, as JSON: it is how a restart
    // tells what changed while majhi was down. Runs go to `automation_runs`.
    id: 102,
    name: "watch triggers",
    sql: `
CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  name TEXT NOT NULL,
  watch TEXT NOT NULL,
  action TEXT NOT NULL,
  overlap TEXT NOT NULL DEFAULT 'skip',
  paused INTEGER NOT NULL DEFAULT 0,
  poll_seconds INTEGER,
  settle_seconds INTEGER NOT NULL DEFAULT 0,
  cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  baseline TEXT,
  last_fired_at TEXT,
  last_run_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX triggers_org ON triggers (org);
`,
  },
  {
    // The commit a task's new branch started from. Rows made before it have none: majhi then falls
    // back to the base branch's newest copy that the task branch contains.
    id: 103,
    name: "task repo start commit",
    sql: `
ALTER TABLE task_repos ADD COLUMN start_commit TEXT;
`,
  },
  {
    // Folders a task's agents may read, mounted read-only: ones the owner mentioned and the repos
    // of an investigation task (JSON array).
    id: 104,
    name: "task read-only mounts",
    sql: `
ALTER TABLE tasks ADD COLUMN read_mounts TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    // What majhi did with a chat: how far memory has read it (the time of the last message read),
    // who last set its title, and how many owner messages it had then.
    id: 105,
    name: "chat memory and title state",
    sql: `
CREATE TABLE chat_state (
  task TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
  extracted_at TEXT,
  titled_by TEXT,
  titled_owner_messages INTEGER NOT NULL DEFAULT 0
);
`,
  },
  {
    // The audit log page lists rows across tasks: each row now carries its org (a task with no org
    // is in "private", as everywhere else) and a detail line, and the list reads newest first.
    id: 106,
    name: "audit org and detail",
    sql: `
ALTER TABLE audit ADD COLUMN org TEXT;
ALTER TABLE audit ADD COLUMN detail TEXT;
UPDATE audit SET org = (SELECT COALESCE(tasks.org, 'private') FROM tasks WHERE tasks.id = audit.task);
CREATE INDEX audit_at ON audit (at);
CREATE INDEX audit_org_at ON audit (org, at);
`,
  },
  {
    // Weekly budgets (PRV-40): one row per alert fired, so each (scope, id, week, threshold) says
    // its line once. A raised budget deletes the rows that are under it again. `week` is the
    // Monday of the week in the owner's time zone. The index serves the weekly sum per account.
    id: 107,
    name: "budget alerts",
    sql: `
CREATE TABLE budget_alerts (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  week TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (scope, id, week, threshold)
);
-- When the owner last resumed a task by hand while a budget had paused it. A 100% alert fired before
-- that moment does not pause the task again; a later one does.
CREATE TABLE budget_resumes (
  task TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
CREATE INDEX turns_account_at ON turns (account, at);
`,
  },
  {
    // Token receipts (SPEC 5.9): what majhi put into a context, one row per event. `brief` once
    // per task (the unique index), `memory` is its Memory section, `recall` a majhi-memory.recall
    // result, `compaction` a context event (`tokens` before, `after_tokens` after, `method` as in the room). Sizes are estimates. `runs.tools`
    // lists the MCP servers a run attached (JSON array).
    id: 108,
    name: "token receipt events and attached tools",
    sql: `
CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  task TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  agent TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('brief', 'memory', 'recall', 'compaction')),
  tokens INTEGER,
  after_tokens INTEGER,
  method TEXT
);
CREATE INDEX usage_events_task ON usage_events (task, kind);
CREATE INDEX usage_events_agent_at ON usage_events (agent, at);
CREATE UNIQUE INDEX usage_events_brief ON usage_events (task) WHERE kind = 'brief';
CREATE UNIQUE INDEX usage_events_memory ON usage_events (task) WHERE kind = 'memory';
ALTER TABLE runs ADD COLUMN tools TEXT;
`,
  },
  {
    // A protected project the owner let agents write in, for one task. Off: agents get it read-only.
    id: 109,
    name: "task repo writes",
    sql: "ALTER TABLE task_repos ADD COLUMN writes INTEGER NOT NULL DEFAULT 0;",
  },
  {
    // The connections a task's root agents get beyond its org's (5.14): named at create, or attached.
    id: 110,
    name: "task connections",
    sql: "ALTER TABLE tasks ADD COLUMN connections TEXT NOT NULL DEFAULT '[]';",
  },
  {
    // The branch tip majhi merged, and where: a squash leaves none of the branch commits behind.
    id: 111,
    name: "task repo shipped head",
    sql: "ALTER TABLE task_repos ADD COLUMN shipped_head TEXT; ALTER TABLE task_repos ADD COLUMN shipped_into TEXT;",
  },
  {
    // Autonomous mode (PRV-74). `autonomy_state` is one row: the mode, who changed it and why, the
    // captain's autonomy chat, the queue it plans (JSON), and the holds seen last (JSON), so a restart
    // does not write their cap events again. `autonomy_tasks` are the tasks it runs; `held` is set
    // while its run gate holds one (`owner` for a pause or a stop, `limit` for a cap, `held_scope`
    // being `day` or the org), so Resume and a lifted cap restart exactly those. `resumed_at` is when
    // the owner last resumed it by hand: the gate lets it run until the mode changes again. The feed is
    // `autonomy_events`; `autonomy_summaries` keeps one daily summary per local day. Tasks get the
    // owner's `priority` and `due` date.
    id: 112,
    name: "autonomous mode",
    sql: `
ALTER TABLE tasks ADD COLUMN priority TEXT;
ALTER TABLE tasks ADD COLUMN due TEXT;
CREATE TABLE autonomy_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'on', 'paused', 'stopping')),
  since TEXT,
  changed_by TEXT,
  why TEXT,
  chat TEXT,
  queue TEXT NOT NULL DEFAULT '[]',
  queued_at TEXT,
  last_tick TEXT,
  holds TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO autonomy_state (id) VALUES (1);
CREATE TABLE autonomy_tasks (
  task TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
  since TEXT NOT NULL,
  held TEXT CHECK (held IN ('owner', 'limit')),
  held_scope TEXT,
  resumed_at TEXT
);
CREATE TABLE autonomy_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  reason TEXT,
  task TEXT,
  org TEXT,
  agent TEXT,
  command TEXT,
  outcome TEXT,
  unsure INTEGER NOT NULL DEFAULT 0,
  item TEXT,
  status TEXT
);
CREATE INDEX autonomy_events_task ON autonomy_events (task, seq);
CREATE INDEX autonomy_events_at ON autonomy_events (at);
CREATE TABLE autonomy_summaries (
  day TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  summary TEXT NOT NULL
);
`,
  },
  {
    // Background e2e (PRV-72). `e2e_runs` is every run of a project's suite after a merge into its
    // base branch: `task` is the task whose merge triggered it (no foreign key: the run outlives the
    // task), `failed_specs` and `traces` are JSON lists, and `break_task` the task a failure opened
    // or found already open. `e2e_breaks` is one row per break, so a break that stays red across many
    // runs opens one task: `closed_at` is set by the first green run after it. `e2e_seen` is the
    // base-branch tip the watcher saw last per project, so a merge made while majhi was down still
    // starts a run, and the first sight of a project starts none.
    id: 113,
    name: "background e2e",
    sql: `
CREATE TABLE e2e_runs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  subject TEXT,
  task TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'errored', 'replaced')),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  passed INTEGER,
  failed INTEGER,
  failed_specs TEXT NOT NULL DEFAULT '[]',
  traces TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  break_task TEXT
);
CREATE INDEX e2e_runs_project ON e2e_runs (project, queued_at);
CREATE TABLE e2e_breaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  task TEXT NOT NULL,
  first_run TEXT NOT NULL,
  first_commit TEXT NOT NULL,
  last_green TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX e2e_breaks_open ON e2e_breaks (project, closed_at);
CREATE TABLE e2e_seen (
  project TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  seen_at TEXT NOT NULL
);
`,
  },
  {
    // What autonomous mode may pick (PRV-74 follow-up). `tasks.no_autonomy` is the owner's mark Not
    // for autonomous mode. `autonomy_tasks.why` keeps the captain's reason for taking a task on.
    // `autonomy_sizes` caches each task's size as the decision provider rated it; `key` is a hash of
    // the title and brief, so an edited task is rated again.
    id: 114,
    name: "autonomy pick rules",
    sql: `
ALTER TABLE tasks ADD COLUMN no_autonomy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE autonomy_tasks ADD COLUMN why TEXT;
CREATE TABLE autonomy_sizes (
  task TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  size TEXT,
  note TEXT NOT NULL,
  at TEXT NOT NULL
);
`,
  },
  {
    // Clone jobs (onboarding and git connect). One row per `projects.clone`, so a job a restart cut
    // off is shown as failed ("majhi restarted") instead of vanishing. `root` is the workspace root
    // the target is in, `created_folder` is 1 when the target did not exist before the job, so only
    // a folder majhi made is removed after an interrupted clone. Retry is a new job.
    id: 115,
    name: "clone jobs",
    sql: `
CREATE TABLE clone_jobs (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  kind TEXT NOT NULL,
  host TEXT NOT NULL,
  full_name TEXT NOT NULL,
  root TEXT NOT NULL,
  path TEXT NOT NULL,
  project TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'cloning', 'registering', 'done', 'failed')),
  phase TEXT,
  percent INTEGER,
  base TEXT,
  reason TEXT,
  created_folder INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX clone_jobs_started ON clone_jobs (started_at);
`,
  },
  {
    // The captain per workspace (Phase 13, SPEC 5.18). `captain_state` holds "Stop the captain".
    // `captain_lanes` is the captain's chat per workspace (`private` for tasks with no org).
    // `captain_runs` is one row per run of an upkeep chore; the partial unique index keeps one open
    // run per chore and workspace. `captain_actions` is the captain's log: `key` makes each action
    // idempotent (a second try of the same key changes nothing), `undo` is JSON for Undo.
    // `captain_chores` counts failures in a row and turns a chore off after two. `captain_presence`
    // is when the owner last acted in a task, so the captain keeps out of it for 10 minutes.
    id: 116,
    name: "captain per workspace",
    sql: `
CREATE TABLE captain_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stopped INTEGER NOT NULL DEFAULT 0,
  stopped_at TEXT,
  summary_day TEXT
);
INSERT INTO captain_state (id) VALUES (1);
CREATE TABLE captain_lanes (
  org TEXT PRIMARY KEY,
  chat TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE captain_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT NOT NULL,
  chore TEXT NOT NULL,
  day TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'capped', 'failed', 'stopped', 'rested')),
  trigger TEXT NOT NULL,
  actions INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE UNIQUE INDEX captain_runs_open ON captain_runs (org, chore) WHERE ended_at IS NULL;
CREATE INDEX captain_runs_day ON captain_runs (org, chore, day);
CREATE TABLE captain_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  run INTEGER,
  org TEXT NOT NULL,
  chore TEXT NOT NULL,
  day TEXT NOT NULL,
  at TEXT NOT NULL,
  text TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT,
  task TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'asked', 'skipped', 'failed')),
  undo TEXT,
  undo_note TEXT,
  undone_at TEXT
);
CREATE INDEX captain_actions_org ON captain_actions (org, at);
CREATE INDEX captain_actions_day ON captain_actions (org, chore, day);
CREATE TABLE captain_chores (
  org TEXT NOT NULL,
  chore TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  off_at TEXT,
  off_why TEXT,
  PRIMARY KEY (org, chore)
);
CREATE TABLE captain_presence (
  task TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
`,
  },
  {
    // The daily summary names the day it covers and compares against the caps of that day.
    // `autonomy_day_caps` keeps, per local day, the caps last seen (JSON: the day cap and each
    // workspace's) and the ones that moved during it (`day` or an org id). Summaries were keyed by
    // the day they were made on, which is the day after the one they cover: they move back a day.
    id: 117,
    name: "autonomy day caps",
    sql: `
CREATE TABLE autonomy_day_caps (
  day TEXT PRIMARY KEY,
  caps TEXT NOT NULL,
  changed TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE autonomy_summaries_moved AS
  SELECT date(day, '-1 day') AS day, at, json_set(summary, '$.day', date(day, '-1 day')) AS summary
  FROM autonomy_summaries;
DELETE FROM autonomy_summaries;
INSERT INTO autonomy_summaries (day, at, summary) SELECT day, at, summary FROM autonomy_summaries_moved;
DROP TABLE autonomy_summaries_moved;
`,
  },
  {
    // A task's link to its tracker item (5.11). The org is the task's own, so a rename follows it.
    // `stage` and `mrs` record what majhi already wrote back, so each is written once.
    id: 118,
    name: "tracker links",
    sql: `
CREATE TABLE tracker_links (
  task TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT,
  mrs TEXT NOT NULL DEFAULT '[]',
  synced_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX tracker_links_key ON tracker_links (type, key);
`,
  },
  {
    // A chore that reached its daily cap in a workspace asks the owner once that day whether to
    // raise it (SPEC 5.18). The key keeps it to one question per chore, workspace and day. `state`:
    // `pending`, `raised` (that day's caps of the chore are doubled) or `left`.
    id: 119,
    name: "captain cap asks",
    sql: `
CREATE TABLE captain_cap_asks (
  org TEXT NOT NULL,
  chore TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  cap INTEGER NOT NULL,
  raise_to INTEGER NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  answered_at TEXT,
  PRIMARY KEY (org, chore, day)
);
`,
  },
];

/** Applies every migration not yet recorded, each in its own transaction. Returns the ids it applied. */
/** Two migrations share an id, in this build or between this build and the database. */
export class MigrationConflict extends Error {}

/**
 * Applies the migrations not applied yet, each in its own transaction, and records it. A migration
 * is known by its id and its name: when the database already holds an id under another name, two
 * branches used the same id and one of them would be skipped without a trace, so this refuses.
 */
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): number[] {
  const seen = new Map<number, string>();
  for (const m of migrations) {
    const other = seen.get(m.id);
    if (other !== undefined) {
      throw new MigrationConflict(
        `Migrations "${other}" and "${m.name}" both use id ${m.id}. Give one of them the next free id.`,
      );
    }
    seen.set(m.id, m.name);
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Map(
    db
      .prepare("SELECT id, name FROM migrations")
      .all()
      .map((row) => [(row as { id: number }).id, (row as { name: string }).name] as const),
  );
  for (const [id, name] of applied) {
    const ours = seen.get(id);
    if (ours !== undefined && ours !== name) {
      throw new MigrationConflict(
        `The database applied migration ${id} as "${name}", but this build's migration ${id} is "${ours}". Two branches used the same id: give this build's migration the next free id.`,
      );
    }
  }
  const record = db.prepare("INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)");
  const done: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.id, m.name, new Date().toISOString());
    })();
    done.push(m.id);
  }
  return done;
}
