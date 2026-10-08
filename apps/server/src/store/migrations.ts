import type Database from "better-sqlite3";
import { stabilizeSlackIds } from "./slack-ids-migration.ts";

export interface Migration {
  /** Increasing, never reused. */
  id: number;
  name: string;
  sql: string;
  /** Data work SQL cannot say, run in the same transaction after `sql`. */
  run?: (db: Database.Database) => void;
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
  {
    // Who paused a task when it was not the owner by hand: the captain, or Autonomous turned off.
    id: 120,
    name: "paused by",
    sql: `ALTER TABLE tasks ADD COLUMN paused_by TEXT;`,
  },
  {
    // A budget (the autonomous budget, `day`, or a workspace's) ran out while work waits: the owner is
    // asked once per budget and day whether to raise it for that day (SPEC 5.18). `state`: `pending`,
    // `raised` (the day's budget is `raise_to`, the saved setting stays) or `left`. Budgets are JSON.
    id: 121,
    name: "autonomy budget asks",
    sql: `
CREATE TABLE autonomy_budget_asks (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  cap TEXT NOT NULL,
  raise_to TEXT NOT NULL,
  waiting INTEGER NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  answered_at TEXT,
  PRIMARY KEY (scope, day)
);
`,
  },
  {
    // The captain's recommendation on a decision of the owner's inbox (SPEC 5.18), by decision id.
    // Decisions themselves are derived from cards and questions; only the opinion is stored.
    id: 122,
    name: "decision recommendations",
    sql: `
CREATE TABLE decision_recommendations (
  id TEXT PRIMARY KEY,
  option TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
`,
  },
  {
    // The captain waits while the owner types in a task (SPEC 5.18), kept in memory: the 10-minute
    // "owner acted" table is not used any more.
    id: 123,
    name: "drop captain presence",
    sql: "DROP TABLE captain_presence;",
  },
  {
    // One-time recheck of memories the old curator handed to the owner. A memory the chore looked at
    // has a log key `memory:<id>` and is never looked at again, so what the old rule handed over
    // ('asked', before the memory fix of 2026-10-04 01:27 +0600) would never be judged by the better
    // rule. The key is renamed, so the log line stays and the next memory run looks at it once more.
    id: 124,
    name: "recheck memories handed to the owner",
    sql: `
UPDATE captain_actions
SET key = key || ':handed-before-recheck'
WHERE chore = 'memory'
  AND outcome = 'asked'
  AND key GLOB 'memory:[0-9]*'
  AND key NOT LIKE 'memory:%:%'
  AND at < '2026-10-03T19:27:50.000Z';
`,
  },
  {
    // Tasks paused when Autonomous was turned off, before `paused_by` existed, read as paused by the
    // owner and the captain never resumed them. A task of the captain or Autonomous (`autonomy_tasks`)
    // paused for the owner, with nobody recorded, within two minutes of a mode event that turned
    // Autonomous off (Stop now writes "Turned off" just after pausing; a graceful stop writes
    // "Stopping after the current turns" just before), was paused by that switch. A task the owner
    // paused by hand at another time keeps no `paused_by`.
    id: 125,
    name: "paused by autonomy off",
    sql: `
UPDATE tasks SET paused_by = 'autonomy-off'
WHERE status = 'paused'
  AND paused_reason = 'owner'
  AND paused_by IS NULL
  AND id IN (SELECT task FROM autonomy_tasks)
  AND EXISTS (
    SELECT 1 FROM autonomy_events e
    WHERE e.kind = 'mode'
      AND (e.text LIKE 'Turned off%' OR e.text LIKE 'Stopping after%')
      AND ABS(julianday(e.at) - julianday(tasks.updated_at)) <= 2.0 / 1440
  );
`,
  },
  {
    // Findings (SPEC 5.18): what the captain's playbooks and agents noticed, deduplicated by key.
    id: 126,
    name: "findings",
    sql: `
CREATE TABLE findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT NOT NULL,
  project TEXT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',
  severity TEXT NOT NULL DEFAULT 'info',
  goal TEXT,
  playbook TEXT,
  channel TEXT,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  task TEXT,
  decision TEXT,
  dismissed_reason TEXT,
  by TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE (org, dedupe_key)
);
CREATE INDEX findings_org_status ON findings (org, status);
`,
  },
  {
    // The project knowledge card (SPEC 5.18, captain v2): one JSON card per project, rewritten when
    // the base branch moves. facts_hash tells whether the facts changed, so the model's paragraph is
    // only rewritten when they did.
    id: 127,
    name: "project cards",
    sql: `
CREATE TABLE project_cards (
  project TEXT PRIMARY KEY,
  card TEXT NOT NULL,
  facts_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    // Outcome labels for decisions (SPEC 5.12): the right answer to one question of one decision,
    // with where it came from. \`decision_links\` holds a decision until its outcome is known (a task
    // finishes, a woken agent's turn ends, the owner keeps or drops a fact), then the labeler writes
    // the label and removes the link.
    id: 128,
    name: "decision labels and links",
    sql: `
CREATE TABLE decision_labels (
  decision_id TEXT NOT NULL,
  use TEXT NOT NULL,
  question TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (decision_id, question, source)
);
CREATE INDEX decision_labels_use ON decision_labels (use, question);
CREATE TABLE decision_links (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  question TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (kind, ref, decision_id, question)
);
`,
  },
  {
    // A captain log line can name the decision it came from, so the owner can say it was wrong.
    id: 129,
    name: "decision on captain log lines",
    sql: `ALTER TABLE captain_actions ADD COLUMN decision TEXT;`,
  },
  {
    // Eval runs of the decision provider (SPEC 5.12): one row per run of a slot over the labeled set
    // or the built-in fixtures, the report as JSON. Kept, so a drift between runs is visible.
    id: 130,
    name: "decision eval runs",
    sql: `
CREATE TABLE decision_evals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot TEXT NOT NULL,
  set_name TEXT NOT NULL,
  at TEXT NOT NULL,
  report TEXT NOT NULL
);
CREATE INDEX decision_evals_slot ON decision_evals (slot, set_name, id);
`,
  },
  {
    // The fitted calibration of each decision slot (SPEC 5.12): the temperature, the bar for the
    // target precision, and whether the slot acts (live) or only logs (shadow). JSON, one per slot.
    id: 131,
    name: "decision calibration per slot",
    sql: `
CREATE TABLE decision_calibration (
  slot TEXT PRIMARY KEY,
  calibration TEXT NOT NULL
);
`,
  },
  {
    // Business memory (SPEC 5.19): a knowledge base with versions and a full-text index, voice profiles,
    // a light CRM and deadlines. org NULL is the whole business; a workspace id is that workspace.
    id: 132,
    name: "business memory",
    sql: `
CREATE TABLE kb_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  sources TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  by TEXT NOT NULL,
  embedding BLOB,
  removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX kb_entries_org ON kb_entries (org, kind);
CREATE TABLE kb_versions (
  entry INTEGER NOT NULL REFERENCES kb_entries (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL,
  sources TEXT NOT NULL,
  verified INTEGER NOT NULL,
  change TEXT NOT NULL,
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (entry, version)
);
CREATE VIRTUAL TABLE kb_fts USING fts5 (title, body, tags, tokenize = 'porter unicode61');
CREATE TABLE voice_profiles (
  scope TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  proposal TEXT
);
CREATE TABLE crm_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT,
  kind TEXT NOT NULL,
  relation TEXT NOT NULL,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  emails TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  owner_only INTEGER NOT NULL DEFAULT 0,
  stage TEXT,
  next_step TEXT NOT NULL DEFAULT '',
  next_due TEXT,
  last_touch TEXT,
  by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX crm_contacts_org ON crm_contacts (org, relation);
CREATE INDEX crm_contacts_due ON crm_contacts (next_due);
CREATE TABLE crm_keys (
  contact INTEGER NOT NULL REFERENCES crm_contacts (id) ON DELETE CASCADE,
  org TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (contact, key)
);
CREATE INDEX crm_keys_lookup ON crm_keys (org, key);
CREATE TABLE crm_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact INTEGER NOT NULL REFERENCES crm_contacts (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  channel TEXT NOT NULL,
  summary TEXT NOT NULL,
  link TEXT,
  by TEXT NOT NULL
);
CREATE INDEX crm_interactions_contact ON crm_interactions (contact, at);
CREATE TABLE deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  due TEXT NOT NULL,
  tz TEXT NOT NULL,
  due_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  lead_days TEXT NOT NULL DEFAULT '[]',
  goal TEXT,
  finding INTEGER,
  contact INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX deadlines_due ON deadlines (status, due_at);
`,
  },
  {
    // Playbooks, goals and the outbound gate (SPEC 5.18, captain v2 step 6): what the owner changed per
    // playbook and workspace, the run history, goals, each channel's mode and the drafts that wait.
    id: 133,
    name: "playbooks goals outbound",
    sql: `
CREATE TABLE playbook_state (
  org TEXT NOT NULL,
  playbook TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  failures INTEGER NOT NULL DEFAULT 0,
  backoff_until TEXT,
  last_run TEXT,
  PRIMARY KEY (org, playbook)
);
CREATE TABLE playbook_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT NOT NULL,
  playbook TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  note TEXT,
  findings INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  chat TEXT
);
CREATE INDEX playbook_runs_pb ON playbook_runs (org, playbook, id);
CREATE UNIQUE INDEX playbook_runs_one_open ON playbook_runs (org, playbook) WHERE status = 'running';
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  title TEXT NOT NULL,
  metric TEXT,
  target TEXT,
  due TEXT,
  status TEXT NOT NULL,
  by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX goals_org ON goals (org, status);
CREATE TABLE outbound_channels (
  org TEXT NOT NULL,
  channel TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'draft',
  batch_at TEXT NOT NULL DEFAULT '09:00',
  auto_by_owner INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org, channel)
);
CREATE TABLE outbound_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT NOT NULL,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  voice TEXT,
  playbook TEXT,
  finding INTEGER,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  result TEXT,
  by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX outbound_drafts_org ON outbound_drafts (org, status);
`,
  },
  {
    // Sensors (SPEC 5.18, captain v2 step 9): what a sensor remembers between runs, so it asks upstream
    // only when something may have changed: ETags, lockfile hashes, advisory and release answers, and
    // the radar's weekly token count. Public answers and counters only, never a secret or a source line.
    id: 134,
    name: "sensor cache",
    sql: `
CREATE TABLE sensor_cache (
  key TEXT PRIMARY KEY,
  etag TEXT,
  hash TEXT,
  body TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  fails INTEGER NOT NULL DEFAULT 0,
  next_at TEXT
);
`,
  },
  {
    // The morning brief and the agenda's review budget (SPEC 5.18, captain v2 step 10): one brief per local
    // day (the primary key is what makes it once per day), and the owner's small agenda settings.
    id: 135,
    name: "morning briefs",
    sql: `
CREATE TABLE morning_briefs (
  day TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  lines TEXT NOT NULL,
  facts TEXT NOT NULL,
  dismissed_at TEXT
);
CREATE TABLE agenda_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    // The secret scan files one finding per project and strength now, not one per file and kind. The
    // per-file ones fold away at once instead of at the next scan, so the list is not buried meanwhile.
    id: 136,
    name: "fold per-file secret findings",
    sql: `
UPDATE findings
SET status = 'dismissed',
    dismissed_reason = 'Folded into one finding per project',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source = 'security'
  AND dedupe_key LIKE 'secret:%'
  AND status IN ('open', 'proposed', 'task', 'decision');
`,
  },
  {
    // The dependency sweep files one finding per project listing its vulnerable packages, not one per
    // advisory and package. The old ones fold away at once.
    id: 137,
    name: "fold per-advisory dependency findings",
    sql: `
UPDATE findings
SET status = 'dismissed',
    dismissed_reason = 'Folded into one finding per project',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source = 'security'
  AND dedupe_key LIKE 'osv:%'
  AND status IN ('open', 'proposed', 'task', 'decision');
`,
  },
  {
    // Outcomes, the scorecard, the trust ladder and the money ceiling (SPEC 5.18, captain v2 step 8).
    // `outcomes` is one row per captain output (`subject` names it: action:12, start:ACM-3, draft:5,
    // finding:9, rec:<decision>), joined to its workspace, authority row or channel (`key`), playbook
    // and task by value, so it outlives a deleted task. `result` is empty until it is judged.
    // `trust_state` is what the ladder last did per workspace and row; `trust_notices` are the Decisions
    // items it raises, with what an undo needs in `data`. `money_state` holds the monthly ceiling and
    // the owner's raise for a month; `org_rates` the optional retainer and hourly rate per workspace.
    id: 138,
    name: "outcomes scorecard trust money",
    sql: `
CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  org TEXT NOT NULL,
  key TEXT,
  playbook TEXT,
  action INTEGER,
  task TEXT,
  at TEXT NOT NULL,
  result TEXT,
  settled_at TEXT
);
CREATE INDEX outcomes_org_at ON outcomes (org, at);
CREATE INDEX outcomes_key ON outcomes (org, key, at);
CREATE INDEX outcomes_playbook ON outcomes (org, playbook, at);
CREATE TABLE trust_state (
  org TEXT NOT NULL,
  key TEXT NOT NULL,
  since TEXT,
  snoozed_until TEXT,
  auto_ok INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org, key)
);
CREATE TABLE trust_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',
  data TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL,
  answered_at TEXT
);
CREATE UNIQUE INDEX trust_notices_open ON trust_notices (org, key, kind) WHERE state = 'open';
CREATE TABLE scorecard_minutes (
  kind TEXT PRIMARY KEY,
  minutes REAL NOT NULL
);
CREATE TABLE money_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE org_rates (
  org TEXT PRIMARY KEY,
  retainer_usd REAL,
  hourly_usd REAL
);
`,
  },
  {
    id: 139,
    name: "ops watch",
    sql: `
CREATE TABLE ops_services (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  def TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ops_services_org ON ops_services(org);
CREATE TABLE ops_state (
  service TEXT NOT NULL,
  kind TEXT NOT NULL,
  recent TEXT NOT NULL DEFAULT '[]',
  fails INTEGER NOT NULL DEFAULT 0,
  last_at TEXT,
  last_ok INTEGER,
  last_detail TEXT NOT NULL DEFAULT '',
  last_ms INTEGER,
  green_since TEXT,
  unknown INTEGER NOT NULL DEFAULT 0,
  warn INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service, kind)
);
CREATE TABLE ops_samples (
  service TEXT NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  ms INTEGER
);
CREATE INDEX ops_samples_at ON ops_samples(service, at);
CREATE TABLE ops_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT NOT NULL,
  service TEXT,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  finding INTEGER,
  opened_at TEXT NOT NULL,
  acked_at TEXT,
  escalated_at TEXT,
  resolved_at TEXT,
  phone_at TEXT,
  phone_escalated_at TEXT,
  flaps INTEGER NOT NULL DEFAULT 0,
  fix TEXT,
  timeline TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX ops_incidents_key ON ops_incidents(key, status);
CREATE TABLE ops_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE ops_phone_tokens (
  jti TEXT PRIMARY KEY,
  decision TEXT NOT NULL,
  action TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX ops_phone_tokens_decision ON ops_phone_tokens(decision);
CREATE TABLE ops_phone_sent (
  decision TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
`,
  },
  {
    // The checked hand-off (SPEC 5.18, captain v2 step 7). `handoff_deep` is the part of a check that
    // costs something (tests, build, lint, the brief's lines, the review), kept by task and head
    // commits so the same head is not run twice. `handoff_history` is one row per head that failed or
    // passed with what was done about it, and `handoff_state` the failed hand-offs in a row.
    id: 140,
    name: "handoff checks",
    sql: `
CREATE TABLE handoff_deep (
  task TEXT NOT NULL,
  head TEXT NOT NULL,
  at TEXT NOT NULL,
  ms INTEGER NOT NULL,
  steps TEXT NOT NULL,
  review TEXT NOT NULL,
  PRIMARY KEY (task, head)
);
CREATE TABLE handoff_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  head TEXT NOT NULL,
  at TEXT NOT NULL,
  verdict TEXT NOT NULL,
  failures TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'none',
  result TEXT NOT NULL DEFAULT '',
  UNIQUE (task, head)
);
CREATE INDEX handoff_history_task ON handoff_history (task, id);
CREATE TABLE handoff_state (
  task TEXT PRIMARY KEY,
  strikes INTEGER NOT NULL DEFAULT 0,
  escalated INTEGER NOT NULL DEFAULT 0
);
`,
  },
  {
    // Laya's triage of a new finding (likely real or noise, with the reason) is kept on the finding, as JSON.
    id: 141,
    name: "finding triage",
    sql: `ALTER TABLE findings ADD COLUMN triage TEXT;`,
  },
  {
    // The captain's day lines are read per workspace and day on every Captain page load. (A partial index on
    // pending room items was left out: a room row whose payload is not JSON would fail json_extract in it.)
    id: 142,
    name: "index for the captain's day lines",
    sql: `
CREATE INDEX captain_actions_org_day ON captain_actions (org, day);
`,
  },
  {
    // Playbooks the owner made (by a sentence or by hand): the spec as JSON, read into the catalog at start.
    id: 143,
    name: "custom playbooks",
    sql: `
CREATE TABLE playbook_custom (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    // Watch anything (5.18): the watches the owner declares, their state and their history of numbers.
    id: 144,
    name: "watch anything",
    sql: `
CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  def TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX watches_org ON watches(org);
CREATE TABLE watch_samples (
  watch TEXT NOT NULL,
  at TEXT NOT NULL,
  v REAL,
  ok INTEGER NOT NULL
);
CREATE INDEX watch_samples_at ON watch_samples(watch, at);
`,
  },
  {
    // Automations are folded into Playbooks and Watch. The old rows stay; `migrated_to` names the
    // playbook or watch each was copied to (see automation/migrate.ts), so nothing runs twice.
    id: 145,
    name: "automations folded into playbooks and watch",
    sql: `
ALTER TABLE schedules ADD COLUMN migrated_to TEXT;
ALTER TABLE triggers ADD COLUMN migrated_to TEXT;
`,
  },
  {
    // The reviews of a merge request as its host last said (approved, changes requested, who is asked).
    id: 146,
    name: "merge request reviews",
    sql: `
ALTER TABLE task_repos ADD COLUMN mr_review TEXT;
`,
  },
  {
    // What waits for the owner is read on every page and tick: without this, each read scanned every
    // room item and parsed its JSON. Cards are few next to messages, so their type narrows it. Not an
    // index on the JSON state: one item with a payload that is not JSON would make it fail.
    id: 147,
    name: "room items by type",
    sql: `
CREATE INDEX room_items_type ON room_items(type);
`,
  },
  {
    // A failed hand-off check is run again when majhi or the runner changed, or after hours: the
    // environment it ran in, and how many times this head was tried.
    id: 150,
    name: "handoff retries",
    sql: `
ALTER TABLE handoff_deep ADD COLUMN env TEXT NOT NULL DEFAULT '';
ALTER TABLE handoff_deep ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
`,
  },
  {
    // The captain's action keys (D9, G1). Every captain action that must happen once per state
    // (a ship, an answer to a card, a note to a lead) takes a key first: `INSERT OR IGNORE` on the
    // primary key is the atomic step, so two calls with the same key make one action. `settled` is 0
    // while the action runs (a claim a crashed call left is taken over after an hour) and 1 once it
    // ran. A key whose action failed is deleted, so it can be tried again.
    id: 151,
    name: "captain action keys",
    sql: `
CREATE TABLE captain_keys (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  task TEXT,
  at TEXT NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX captain_keys_task ON captain_keys (task);
`,
  },
  {
    // The loop guard's count (D10): the captain's answers to one task since the task last made
    // progress. `mark` is the progress it was counted against (status and branch heads), so a commit
    // or a status change starts the count again. `paused` is 1 once the guard paused the task for this count.
    id: 152,
    name: "captain loop guard",
    sql: `
CREATE TABLE captain_loop_guard (
  task TEXT PRIMARY KEY,
  mark TEXT NOT NULL,
  answers INTEGER NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0
);
`,
  },
  {
    // Perf pass on the data layer (153). Every list the UI opens and every loop tick scanned a table
    // that grows for ever. `pending` is a virtual column over the room item's JSON `state`, so what waits
    // for the owner is one indexed lookup instead of a JSON parse per card ever made. It is guarded with
    // `json_valid`, so a payload that is not JSON (a damaged row) reads as not pending and cannot make
    // the index fail. Nothing to backfill: SQLite computes it from the payload.
    id: 153,
    name: "indexes for hot lookups",
    sql: `
ALTER TABLE room_items ADD COLUMN pending INTEGER GENERATED ALWAYS AS (
  CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload, '$.state') = 'pending', 0) ELSE 0 END
) VIRTUAL;
CREATE INDEX room_items_pending ON room_items (type, task) WHERE pending = 1;
CREATE INDEX tasks_status ON tasks (status, updated_at);
CREATE INDEX tasks_chat ON tasks (brief) WHERE kind = 'chat';
CREATE INDEX task_repos_open_mr ON task_repos (task) WHERE mr_state IS NOT NULL AND mr_state != 'merged';
CREATE INDEX findings_created ON findings (created_at);
CREATE INDEX findings_status_seen ON findings (status, last_seen);
CREATE INDEX autonomy_events_kind_at ON autonomy_events (kind, at);
CREATE INDEX outcomes_at ON outcomes (at);
CREATE INDEX captain_actions_at ON captain_actions (at);
CREATE INDEX audit_kind ON audit (kind);
CREATE INDEX audit_agent ON audit (agent);
`,
  },
  {
    // The task lifecycle's audit trail (step C, docs/design/task-lifecycle.md sections 4.5 and 12).
    // `apply()` writes the new state and one row here in the same transaction, a refusal too
    // (`refused` = 1, nothing else written). `hold` is the cause of the hold after the event,
    // `from_hold` the one before. `pending_effects` is the outbox: the JSON list of effects that must
    // not be lost, written in that transaction and cleared once they ran; a restart runs what is left.
    // 154 is taken by the ops hygiene migration and 155 is left for another branch in flight.
    id: 156,
    name: "task lifecycle events",
    sql: `
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  from_hold TEXT,
  hold TEXT,
  actor TEXT NOT NULL,
  refused INTEGER NOT NULL DEFAULT 0,
  code TEXT,
  text TEXT,
  pending_effects TEXT
);
CREATE INDEX task_events_task ON task_events (task, id);
CREATE INDEX task_events_pending ON task_events (id) WHERE pending_effects IS NOT NULL;
`,
  },
  {
    // Leftovers of removed features (154). The sensors (radar, ci, dependency, eol, opportunity, tracker)
    // no longer exist, so the findings they filed can never be refreshed or closed by anything: the open
    // ones are dismissed once, with the reason. A finding that already has a task, a decision or a
    // proposal keeps its status. The public tracker comment channel is gone too: its mode rows, drafts,
    // trust state and trust notices are deleted so no list names it.
    id: 154,
    name: "retire findings of removed sources and the tracker comment channel",
    sql: `
UPDATE findings
   SET status = 'dismissed',
       dismissed_reason = 'Its source was removed from majhi',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status = 'open' AND source IN ('radar', 'ci', 'dependency', 'eol', 'opportunity', 'tracker');
DELETE FROM outbound_drafts WHERE channel = 'tracker-comment';
DELETE FROM outbound_channels WHERE channel = 'tracker-comment';
DELETE FROM trust_state WHERE key = 'outbound:tracker-comment';
DELETE FROM trust_notices WHERE key = 'outbound:tracker-comment';
`,
  },
  {
    // One typed state per connection (SPEC 5.14): connecting, connected (verified, with when and what
    // was checked), failed or needs-attention. Stored as JSON of ConnectionHealthSchema. A connection
    // with no row is checked once at startup, and its row is made from the result.
    id: 157,
    name: "connection health",
    sql: `
CREATE TABLE connection_health (
  connection TEXT PRIMARY KEY,
  health TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    // The chat dock's read state (owner only): one row per conversation (a task room or a captain
    // thread, both rooms keyed by task id) holding the `at` of the newest message the owner has seen.
    // Unread is the agent messages after it, so nothing is stored per message. Every conversation
    // that exists now starts fully read (its newest agent message), so the first badge counts only
    // replies that arrive after this update. The index serves the per-conversation count and the
    // newest agent message with one seek each.
    id: 158,
    name: "chat dock read marks",
    sql: `
CREATE TABLE read_marks (
  id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX room_items_task_type_at ON room_items (task, type, at);
INSERT INTO read_marks (id, read_at, updated_at)
  SELECT task, max(at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM room_items
   WHERE type = 'agent' AND task IN (SELECT id FROM tasks)
   GROUP BY task;
`,
  },
  {
    // Which skills a run had at launch (names, a JSON array like `tools`; NULL for runs made before it
    // was recorded) and each time an agent used one. A use is keyed by its tool call, so the several
    // reports of one call count once. The index serves "last used" and "uses in 30 days" per skill.
    id: 159,
    name: "skills of runs and skill uses",
    sql: `
ALTER TABLE runs ADD COLUMN skills TEXT;
CREATE TABLE skill_uses (
  run INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (run, tool_call_id)
);
CREATE INDEX skill_uses_skill_at ON skill_uses (skill, at);
`,
  },
  {
    // The project map (5.20): one row per workspace with its boxes, lines and the lines the owner removed
    // (JSON, checked by zod when read), when it was updated and the last update's report. The id leaves a
    // gap on purpose: other work adds migrations at the same time.
    id: 163,
    name: "project map per workspace",
    sql: `
CREATE TABLE project_maps (
  org TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 1,
  nodes TEXT NOT NULL,
  edges TEXT NOT NULL,
  removed TEXT NOT NULL,
  updated_at TEXT,
  report TEXT
);
`,
  },
  {
    // The map's addresses, the owner's answers about them and role choices (JSON, checked by zod when read).
    // A map stored before it has none reads as never updated, so the next update draws it again.
    id: 168,
    name: "project map addresses and answers",
    sql: `ALTER TABLE project_maps ADD COLUMN extra TEXT;`,
  },
  {
    // Journeys on the project map: ordered steps over the map's lines, named by the owner. Steps are JSON
    // (checked by zod when read). They live apart from the map so an update never rewrites them.
    id: 169,
    name: "project map journeys",
    sql: `
CREATE TABLE map_journeys (
  org TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  steps TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- What starts it and, for a journey inside one project, which project and entry point (JSON).
  extra TEXT,
  PRIMARY KEY (org, id)
);
`,
  },
  {
    // "Merge when checks pass": the owner's merge, held until the hand-off check of the exact head it
    // was asked for is green (JSON QueuedMerge, checked by zod when read). One per task.
    id: 170,
    name: "queued merges",
    sql: `CREATE TABLE queued_merges (task TEXT PRIMARY KEY, body TEXT NOT NULL);`,
  },
  {
    // The project wiki (docs/design/wiki.md): one row per page (JSON, checked by zod when read; a row that no
    // longer parses reads as absent), with the commits it was built from. A page with no project is the
    // workspace's. Saving a changed page moves the row it replaces into wiki_page_versions, so no version is
    // lost. wiki_state is one row per project: the commit its pages were built from, which files each page was
    // written from (JSON) and the last error. The Map's tables stay, unused.
    id: 171,
    name: "project wiki pages",
    sql: `
CREATE TABLE wiki_pages (
  n INTEGER PRIMARY KEY,
  org TEXT NOT NULL,
  project TEXT,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  page TEXT NOT NULL,
  built_from TEXT NOT NULL,
  v INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX wiki_pages_key ON wiki_pages (org, ifnull(project, ''), id);
CREATE TABLE wiki_page_versions (
  page_n INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  org TEXT NOT NULL,
  project TEXT,
  id TEXT NOT NULL,
  page TEXT NOT NULL,
  built_from TEXT NOT NULL,
  v INTEGER NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (page_n, seq)
);
CREATE TABLE wiki_state (
  org TEXT NOT NULL,
  project TEXT NOT NULL,
  built_commit TEXT,
  sources TEXT NOT NULL DEFAULT '{}',
  rules INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT,
  PRIMARY KEY (org, project)
);
`,
  },
  {
    // The wiki's plan and gaps (W5): the main flows chosen at the first build (JSON, kept so a page id never
    // changes between updates), and what the writer could not settle or write, per page (JSON), kept until
    // that page is written again.
    id: 172,
    name: "wiki plan and gaps",
    sql: `
ALTER TABLE wiki_state ADD COLUMN plan TEXT;
ALTER TABLE wiki_state ADD COLUMN gaps TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    // The Map's upkeep chore became the wiki's (W5), so the captain's history keeps its rows. The chore `map` is
    // `wiki` and the playbook `upkeep-map` is `upkeep-wiki`. A table with a key on the name takes the update
    // where the new name is free (UPDATE OR IGNORE); a row left under the old name is the same thing already
    // under the new one, and goes. A run still open under the old name is closed first: a closed run cannot
    // block the wiki chore, an open one would hold its slot for good.
    id: 173,
    name: "captain map chore becomes wiki",
    sql: `
UPDATE captain_runs SET status = 'stopped', ended_at = started_at, note = 'The map chore was replaced by the wiki chore.'
  WHERE chore = 'map' AND ended_at IS NULL;
UPDATE captain_runs SET chore = 'wiki' WHERE chore = 'map';
UPDATE OR IGNORE captain_actions
  SET chore = 'wiki', key = CASE WHEN key LIKE 'map:%' THEN 'wiki:' || substr(key, 5) ELSE key END
  WHERE chore = 'map';
DELETE FROM captain_actions WHERE chore = 'map';
UPDATE OR IGNORE captain_chores SET chore = 'wiki' WHERE chore = 'map';
DELETE FROM captain_chores WHERE chore = 'map';
UPDATE OR IGNORE captain_cap_asks SET chore = 'wiki' WHERE chore = 'map';
DELETE FROM captain_cap_asks WHERE chore = 'map';

UPDATE playbook_runs SET status = 'stopped', ended_at = started_at, note = 'The map playbook was replaced by the wiki playbook.'
  WHERE playbook = 'upkeep-map' AND status = 'running';
UPDATE playbook_runs SET playbook = 'upkeep-wiki' WHERE playbook = 'upkeep-map';
UPDATE OR IGNORE playbook_state
  SET playbook = 'upkeep-wiki', state = replace(state, '"map-update"', '"wiki-update"')
  WHERE playbook = 'upkeep-map';
DELETE FROM playbook_state WHERE playbook = 'upkeep-map';
UPDATE findings SET playbook = 'upkeep-wiki' WHERE playbook = 'upkeep-map';
UPDATE outcomes SET playbook = 'upkeep-wiki' WHERE playbook = 'upkeep-map';
UPDATE outbound_drafts SET playbook = 'upkeep-wiki' WHERE playbook = 'upkeep-map';
`,
  },
  {
    // What the owner told the wiki of a workspace (docs/design/wiki.md, step 2, rule 4): what an address or a call is,
    // and what a role the writer guessed really is. One row per answer, JSON checked by zod when read; a row that no
    // longer parses reads as absent. The key makes a later answer to the same question replace the earlier one.
    id: 174,
    name: "wiki owner answers",
    sql: `
CREATE TABLE wiki_answers (
  org TEXT NOT NULL,
  key TEXT NOT NULL,
  answer TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org, key)
);
`,
  },
  {
    // The ref a task's start commit was taken from (`main` or `origin/main`), so TASK.md can say which.
    id: 175,
    name: "task repo start ref",
    sql: `
ALTER TABLE task_repos ADD COLUMN start_ref TEXT;
`,
  },
  {
    // What a task is and where it came from. Tasks made before this have neither: no type reads as "untyped" and
    // no origin as unknown, and nothing is guessed for them. `type` and `type_by` are set together or not at all
    // (zod checks the pair when a row is read); `origin` is JSON (StoredOrigin), a row that no longer parses reads as
    // none. A child's parent is its task_links row, never stored here.
    id: 176,
    name: "task type and origin",
    sql: `
ALTER TABLE tasks ADD COLUMN type TEXT;
ALTER TABLE tasks ADD COLUMN type_by TEXT;
ALTER TABLE tasks ADD COLUMN origin TEXT;
`,
  },
  {
    // Deploys (docs/design/ship-without-me.md, section 3). One row per target and commit: asking again for the same
    // pair finds this row, which is what makes a deploy happen once. `run`, `check_result` and `rollback` are JSON
    // that zod checks when a row is read. The `landed_*` columns of a task repo are the commit its work landed in
    // (the base tip right after majhi merged it, or the fetched base tip once its merge request merged) and when.
    id: 177,
    name: "deploys and landed commits",
    sql: `
CREATE TABLE deploys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT NOT NULL,
  project TEXT NOT NULL,
  env TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  previous TEXT,
  state TEXT NOT NULL,
  task TEXT,
  by TEXT NOT NULL,
  run TEXT,
  check_result TEXT,
  reason TEXT,
  rollback TEXT,
  incident TEXT,
  unchecked INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (project, env, commit_sha)
);
CREATE INDEX deploys_task ON deploys (task);
CREATE INDEX deploys_state ON deploys (state);
ALTER TABLE task_repos ADD COLUMN landed_commit TEXT;
ALTER TABLE task_repos ADD COLUMN landed_into TEXT;
ALTER TABLE task_repos ADD COLUMN landed_at TEXT;
`,
  },
  {
    // Deploys v2 (docs/briefs/deploy-v2.md). A record carries the runs to start, in order (`runs`, JSON checked by zod
    // on read), its place in the task's plan (`seq`) and the captain's note. The `run` column now holds the provider's
    // run of each of `runs` (a JSON list; a row from before holds one run and reads as a list of one). The new state
    // `planned` needs no column.
    id: 178,
    name: "deploy runs, plan order and notes",
    sql: `
ALTER TABLE deploys ADD COLUMN runs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE deploys ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deploys ADD COLUMN note TEXT;
`,
  },
  {
    // Client chats (docs/briefs/client-chats.md). A client room is a chat task with `client`, the chat it is (JSON,
    // ClientRoom), unique per chat. A message of a chat app carries `external`, its key as one string, unique, so a
    // repeat delivery stores nothing. Contacts are who the clients are: identities are unique per workspace and
    // app account, and a merge keeps a snapshot of what it absorbed, so it can be undone exactly. A connection's
    // runtime state gets the read position of its chat app (`cursor`).
    id: 179,
    name: "client chats",
    sql: `
ALTER TABLE tasks ADD COLUMN client TEXT;
CREATE UNIQUE INDEX tasks_client_chat ON tasks (
  json_extract(client, '$.app'), json_extract(client, '$.account'), json_extract(client, '$.chat')
) WHERE client IS NOT NULL;
ALTER TABLE room_items ADD COLUMN external TEXT;
CREATE UNIQUE INDEX room_items_external ON room_items (external) WHERE external IS NOT NULL;
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  name TEXT NOT NULL,
  tz TEXT,
  lang TEXT,
  us INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX contacts_org ON contacts (org);
CREATE TABLE contact_ids (
  contact TEXT NOT NULL,
  org TEXT NOT NULL,
  app TEXT NOT NULL,
  account TEXT NOT NULL,
  native TEXT NOT NULL,
  PRIMARY KEY (org, app, account, native)
);
CREATE INDEX contact_ids_contact ON contact_ids (contact);
CREATE TABLE contact_merges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kept TEXT NOT NULL,
  absorbed TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  at TEXT NOT NULL,
  undone_at TEXT
);
ALTER TABLE connection_health ADD COLUMN cursor TEXT;
`,
  },
  {
    // The handle a chat app shows for a person (Telegram's @username), kept beside the app's own user id. It can
    // change, so it is refreshed on each message. Identity stays the user id.
    id: 180,
    name: "contact usernames",
    sql: `
ALTER TABLE contact_ids ADD COLUMN username TEXT;
`,
  },
  {
    // An unlinked client room is archived: it keeps its history under its workspace and gives up its chat, so the
    // chat can be linked again as a fresh room. Only a live room is unique per chat.
    id: 181,
    name: "archived client rooms free their chat",
    sql: `
DROP INDEX tasks_client_chat;
CREATE UNIQUE INDEX tasks_client_chat ON tasks (
  json_extract(client, '$.app'), json_extract(client, '$.account'), json_extract(client, '$.chat')
) WHERE client IS NOT NULL AND json_extract(client, '$.archived') IS NOT 1;
`,
  },
  {
    // The Chats list holds the chats the owner started with an agent too. They had no read marks, so each
    // starts fully read, and the owner can archive any conversation: hidden from the list, history kept.
    id: 182,
    name: "conversation archive and agent chat read marks",
    sql: `
CREATE TABLE conversation_archive (
  id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  archived_at TEXT NOT NULL
);
INSERT INTO read_marks (id, read_at, updated_at)
  SELECT r.task, max(r.at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM room_items r JOIN tasks t ON t.id = r.task
   WHERE r.type = 'agent' AND t.kind = 'chat' AND t.brief IN ('Chat', 'Captain chat')
     AND r.task NOT IN (SELECT id FROM read_marks)
   GROUP BY r.task;
`,
  },
  {
    // One Slack person is one identity: the user id. Ids that carried a per-message team prefix are rewritten,
    // and contacts that now share an identity are merged, each merge logged so it can be undone.
    id: 183,
    name: "stable slack person ids",
    sql: "",
    run: stabilizeSlackIds,
  },
  {
    // A task an agent made from a chat with the owner now names that chat (origin `chat`), so the chat can
    // say "Work moved to ..." and the task "From the chat ...". Old tasks are found from the applied
    // `tasks.create` card in the chat's room, whose result starts with the new task's JSON. Only a task with
    // no origin, or one recorded as the captain's, changes; a task made by hand or from a finding stays.
    id: 184,
    name: "tasks made from chats",
    sql: `
UPDATE tasks SET origin = json_object('kind', 'chat', 'room', (
  SELECT i.task FROM room_items i JOIN tasks c ON c.id = i.task
   WHERE c.kind = 'chat' AND c.brief = 'Chat' AND i.type = 'approval'
     AND CASE WHEN json_valid(i.payload) THEN json_extract(i.payload, '$.command') END = 'tasks.create'
     AND CASE WHEN json_valid(i.payload) THEN json_extract(i.payload, '$.state') END = 'applied'
     AND CASE WHEN json_valid(i.payload) THEN json_extract(i.payload, '$.result') END LIKE '%{"id":"' || tasks.id || '"%'
   ORDER BY i.seq LIMIT 1))
 WHERE kind != 'chat' AND (origin IS NULL OR json_extract(origin, '$.kind') = 'captain')
   AND EXISTS (
  SELECT 1 FROM room_items i JOIN tasks c ON c.id = i.task
   WHERE c.kind = 'chat' AND c.brief = 'Chat' AND i.type = 'approval'
     AND CASE WHEN json_valid(i.payload) THEN json_extract(i.payload, '$.command') END = 'tasks.create'
     AND CASE WHEN json_valid(i.payload) THEN json_extract(i.payload, '$.state') END = 'applied'
     AND CASE WHEN json_valid(i.payload) THEN json_extract(i.payload, '$.result') END LIKE '%{"id":"' || tasks.id || '"%');
`,
  },
  {
    // Who did it, as the Actor in JSON: who dismissed a finding, and who an autonomy History line is
    // about. Rows from before have none.
    id: 185,
    name: "who did it",
    sql: `ALTER TABLE findings ADD COLUMN dismissed_by TEXT;
ALTER TABLE autonomy_events ADD COLUMN by TEXT;`,
  },
  {
    // The captain's lane per workspace and job: backlog and routine turns keep the first chat, and urgent
    // reacting work (a client message, an incident) gets a second one, so it never queues behind a long turn.
    id: 186,
    name: "captain lanes per job",
    sql: `
CREATE TABLE captain_lanes_by_job (
  org TEXT NOT NULL,
  job TEXT NOT NULL DEFAULT 'backlog' CHECK (job IN ('backlog', 'reacting')),
  chat TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org, job)
);
INSERT INTO captain_lanes_by_job (org, job, chat, created_at) SELECT org, 'backlog', chat, created_at FROM captain_lanes;
DROP TABLE captain_lanes;
ALTER TABLE captain_lanes_by_job RENAME TO captain_lanes;
`,
  },
  {
    // A line of a captain's workspace thread can be about a task (`about` in the payload): the task page reads those
    // lines from the thread's room, and the thread leaves them out. A client message that became or joined a task
    // names it in its outcome (`outcome_task`), and the task shows it. Virtual columns and indexes make each read
    // one lookup. Nothing to backfill: SQLite computes it from the payload.
    id: 190,
    name: "room items about a task",
    sql: `
ALTER TABLE room_items ADD COLUMN about TEXT GENERATED ALWAYS AS (
  CASE WHEN json_valid(payload) THEN json_extract(payload, '$.about') END
) VIRTUAL;
CREATE INDEX room_items_about ON room_items (about, at) WHERE about IS NOT NULL;
ALTER TABLE room_items ADD COLUMN outcome_task TEXT GENERATED ALWAYS AS (
  CASE WHEN json_valid(payload) THEN json_extract(payload, '$.outcome.task') END
) VIRTUAL;
CREATE INDEX room_items_outcome_task ON room_items (outcome_task, at) WHERE outcome_task IS NOT NULL;
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
      m.run?.(db);
      record.run(m.id, m.name, new Date().toISOString());
    })();
    done.push(m.id);
  }
  return done;
}
