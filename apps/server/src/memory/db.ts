import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { migrate } from "../store/migrations.ts";
import { MEMORY_MIGRATIONS } from "./migrations.ts";

export const MEMORY_DB_PATH = ["memory", "memory.db"] as const;

/**
 * Opens `memory.db` (or `:memory:`) with the `sqlite-vec` extension loaded, and applies the memory
 * migrations. The extension ships a prebuilt library per platform (linux x64 and arm64, macOS),
 * found through the `sqlite-vec-<platform>` package npm installed next to it.
 */
export function openMemoryDb(file: string): Database.Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  migrate(db, MEMORY_MIGRATIONS);
  return db;
}
