import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "./migrations.ts";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof createDb>["db"];

export const BUSY_TIMEOUT_MS = 5_000;

/** The oldest SQLite without the WAL-reset race (fixed in 3.51.3; it affected 3.7.0 to 3.51.2). */
export const MIN_SQLITE_VERSION = "3.51.3";

/** What the connection runs with, read back from SQLite after the pragmas are set. */
export interface SqliteBaseline {
  version: string;
  journalMode: string;
  /** 1 is NORMAL. */
  synchronous: number;
  busyTimeoutMs: number;
  foreignKeys: boolean;
  /** False when the bundled SQLite is older than {@link MIN_SQLITE_VERSION}. */
  versionOk: boolean;
}

/** Statements kept per connection. Hot queries repeat; a dynamic one (an IN list) ages out. */
const STATEMENT_CACHE_MAX = 400;

/** True when dotted version `a` is at least `b`. */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Sets the pragmas majhi relies on and reads them back, so a pragma that did not take is seen. */
export function applyBaseline(sqlite: Database.Database): SqliteBaseline {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  sqlite.pragma("synchronous = NORMAL");
  const version = String(sqlite.prepare("SELECT sqlite_version() AS v").pluck().get());
  return {
    version,
    journalMode: String(sqlite.pragma("journal_mode", { simple: true })),
    synchronous: Number(sqlite.pragma("synchronous", { simple: true })),
    busyTimeoutMs: Number(sqlite.pragma("busy_timeout", { simple: true })),
    foreignKeys: sqlite.pragma("foreign_keys", { simple: true }) === 1,
    versionOk: versionAtLeast(version, MIN_SQLITE_VERSION),
  };
}

/**
 * Makes `prepare` hand back the same compiled statement for the same SQL text. Repos that call
 * `db.prepare(sql)` on every call (and Drizzle, which does the same underneath) stop paying to compile
 * the query each time. Statements are only ever run with `get`, `all` and `run`, so sharing one is safe.
 */
export function cacheStatements(sqlite: Database.Database): void {
  const cache = new Map<string, Database.Statement>();
  const prepare = sqlite.prepare.bind(sqlite) as (sql: string) => Database.Statement;
  sqlite.prepare = ((sql: string) => {
    const hit = cache.get(sql);
    if (hit !== undefined) return hit;
    const stmt = prepare(sql);
    cache.set(sql, stmt);
    if (cache.size > STATEMENT_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return stmt;
  }) as Database.Database["prepare"];
}

/** Opens `majhi.db` (or `:memory:`) with WAL, foreign keys and a busy timeout, and applies migrations. */
export function createDb(file: string): {
  sqlite: Database.Database;
  db: ReturnType<typeof wrap>;
  baseline: SqliteBaseline;
} {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  const baseline = applyBaseline(sqlite);
  migrate(sqlite);
  cacheStatements(sqlite);
  return { sqlite, db: wrap(sqlite), baseline };
}

function wrap(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

/** One line for the boot log, plus a warning for anything below the baseline. */
export function logSqliteBaseline(b: SqliteBaseline): void {
  console.log(
    `sqlite ${b.version}, journal ${b.journalMode}, synchronous ${b.synchronous}, busy timeout ${b.busyTimeoutMs} ms, foreign keys ${b.foreignKeys ? "on" : "off"}`,
  );
  if (!b.versionOk)
    console.warn(
      `sqlite ${b.version} is older than ${MIN_SQLITE_VERSION}, which fixed a rare WAL reset race`,
    );
  if (b.journalMode !== "wal" || b.synchronous !== 1 || b.busyTimeoutMs < BUSY_TIMEOUT_MS || !b.foreignKeys)
    console.warn(
      "sqlite pragmas are below the baseline (wal, synchronous normal, busy timeout 5000, foreign keys)",
    );
}
