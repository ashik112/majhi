import Database from "better-sqlite3";

/**
 * The page cache of each SQLite connection, in KiB. The SQLite bundled with better-sqlite3 is built
 * with a default of 16 MB per connection (`DEFAULT_CACHE_SIZE=-16000`), and a backup, a check or any
 * scan of a big table fills it and keeps it for the life of the connection. majhi's connections read
 * a few hot tables and stream the rest, so 4 MB holds what is reused. Measured in the server image on a
 * 157 MB database: one backup raised the process by 35 MB with the default and by 11 MB with this.
 */
export const PAGE_CACHE_KIB = 4_000;

/** Opens a database file with the page cache above. Every connection of the server goes through here. */
export function openSqlite(file: string, options?: Database.Options): Database.Database {
  const sqlite = new Database(file, options);
  sqlite.pragma(`cache_size = -${PAGE_CACHE_KIB}`);
  return sqlite;
}
