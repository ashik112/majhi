import type { Migration } from "../store/migrations.ts";

/** Dimensions of `Xenova/all-MiniLM-L6-v2`. */
export const EMBEDDING_DIMS = 384;

/**
 * The memory store's own migrations, applied in order at startup and tracked in its `migrations`
 * table. Never edit one that shipped: add the next.
 */
export const MEMORY_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "facts, search indexes and the log",
    sql: `
CREATE TABLE facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  scope TEXT NOT NULL,
  task TEXT,
  agent TEXT,
  status TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  promoted TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  duplicate_of INTEGER REFERENCES facts (id),
  decided_by TEXT
);
CREATE INDEX facts_status_scope ON facts (status, scope);
CREATE INDEX facts_task ON facts (task);

-- rowid is the fact id in both indexes.
CREATE VIRTUAL TABLE facts_fts USING fts5 (text, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE facts_vec USING vec0 (embedding float[${EMBEDDING_DIMS}]);

CREATE TABLE memory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact INTEGER NOT NULL REFERENCES facts (id),
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  task TEXT,
  reason TEXT,
  confidence REAL,
  provider TEXT,
  at TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX memory_events_fact ON memory_events (fact);
CREATE INDEX memory_events_task ON memory_events (task);

-- The facts a task was given, so its TASK.md is the same each time it is written and a fact's
-- use count goes up once per task.
CREATE TABLE task_recalls (
  task TEXT NOT NULL,
  fact INTEGER NOT NULL REFERENCES facts (id),
  rank INTEGER NOT NULL,
  PRIMARY KEY (task, fact)
);
`,
  },
  {
    id: 2,
    name: "what a logged step changed, for undo",
    sql: `
-- The fact's status before the step. Null for a step that changed no fact.
ALTER TABLE memory_events ADD COLUMN from_status TEXT;
`,
  },
  {
    id: 3,
    name: "task records, project briefs, open threads",
    sql: `
-- One record per finished task, written by the Housekeeper. Written again only when the owner asks.
CREATE TABLE task_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  org TEXT,
  projects TEXT NOT NULL,
  asked TEXT NOT NULL,
  done TEXT NOT NULL,
  decisions TEXT NOT NULL,
  outcome TEXT NOT NULL,
  left_open TEXT NOT NULL,
  repos TEXT NOT NULL,
  agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- The scopes a record is seen in: its org and each of its projects. Never global.
CREATE TABLE record_scopes (
  record INTEGER NOT NULL REFERENCES task_records (id),
  scope TEXT NOT NULL,
  PRIMARY KEY (record, scope)
);
CREATE INDEX record_scopes_scope ON record_scopes (scope);
CREATE VIRTUAL TABLE records_fts USING fts5 (title, body, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE records_vec USING vec0 (embedding float[${EMBEDDING_DIMS}]);

-- Every version of each project's brief. The newest is the brief.
CREATE TABLE project_briefs (
  project TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  task TEXT,
  restored_from INTEGER,
  agent TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project, version)
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  project TEXT,
  org TEXT,
  task TEXT NOT NULL,
  follow_up TEXT,
  status TEXT NOT NULL,
  closed_by TEXT,
  closed_reason TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX threads_project ON threads (project, status);
CREATE INDEX threads_task ON threads (task);
CREATE INDEX threads_follow_up ON threads (follow_up);

-- The Memory section a task got in its TASK.md, so a rewrite of TASK.md gives the same text.
CREATE TABLE task_memory (
  task TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  at TEXT NOT NULL
);

-- One-time steps and their time.
CREATE TABLE memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];
