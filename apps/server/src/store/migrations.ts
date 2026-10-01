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
];

/** Applies every migration not yet recorded, each in its own transaction. Returns the ids it applied. */
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare("SELECT id FROM migrations")
      .all()
      .map((row) => (row as { id: number }).id),
  );
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
