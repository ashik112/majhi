import type Database from "better-sqlite3";

export interface Migration {
  /** Increasing, never reused. */
  id: number;
  name: string;
  sql: string;
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
