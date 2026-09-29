import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "./migrations.ts";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof createDb>["db"];

export const BUSY_TIMEOUT_MS = 5_000;

/** Opens `majhi.db` (or `:memory:`) with WAL, foreign keys and a busy timeout, and applies migrations. */
export function createDb(file: string): { sqlite: Database.Database; db: ReturnType<typeof wrap> } {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  sqlite.pragma("synchronous = NORMAL");
  migrate(sqlite);
  return { sqlite, db: wrap(sqlite) };
}

function wrap(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}
