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
];
