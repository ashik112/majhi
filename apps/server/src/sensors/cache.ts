import type Database from "better-sqlite3";

/**
 * What sensors remember between runs: ETags, hashes, upstream answers and counters. Public answers
 * and numbers only. A row that does not parse is dropped by its reader, so a bad row costs one request.
 */
export interface CacheRow {
  key: string;
  etag: string | undefined;
  hash: string | undefined;
  body: string;
  at: string;
  fails: number;
  nextAt: string | undefined;
}

interface Raw {
  key: string;
  etag: string | null;
  hash: string | null;
  body: string;
  at: string;
  fails: number;
  next_at: string | null;
}

export class SensorCache {
  constructor(private readonly db: Database.Database) {}

  get(key: string): CacheRow | undefined {
    const r = this.db.prepare("SELECT * FROM sensor_cache WHERE key = ?").get(key) as Raw | undefined;
    return r === undefined
      ? undefined
      : {
          key: r.key,
          etag: r.etag ?? undefined,
          hash: r.hash ?? undefined,
          body: r.body,
          at: r.at,
          fails: r.fails,
          nextAt: r.next_at ?? undefined,
        };
  }

  put(row: Omit<CacheRow, "fails" | "etag" | "hash" | "nextAt"> & Partial<CacheRow>): void {
    this.db
      .prepare(
        `INSERT INTO sensor_cache (key, etag, hash, body, at, fails, next_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, hash = excluded.hash, body = excluded.body,
           at = excluded.at, fails = excluded.fails, next_at = excluded.next_at`,
      )
      .run(row.key, row.etag ?? null, row.hash ?? null, row.body, row.at, row.fails ?? 0, row.nextAt ?? null);
  }

  /** The key's JSON, or undefined when it is missing or does not parse. */
  json<T>(key: string, parse: (raw: unknown) => T | undefined): { row: CacheRow; value: T } | undefined {
    const row = this.get(key);
    if (row === undefined) return undefined;
    try {
      const value = parse(JSON.parse(row.body) as unknown);
      return value === undefined ? undefined : { row, value };
    } catch {
      return undefined;
    }
  }

  /** Adds to a counter row (`body` holds the number). */
  add(key: string, n: number, at: string): number {
    const now = this.count(key) + n;
    this.put({ key, body: String(now), at });
    return now;
  }

  count(key: string): number {
    const n = Number(this.get(key)?.body ?? "0");
    return Number.isFinite(n) ? n : 0;
  }
}

/** Whether a cached row is younger than `ms`. */
export function fresh(row: Pick<CacheRow, "at"> | undefined, ms: number, now: Date): boolean {
  return row !== undefined && now.getTime() - Date.parse(row.at) < ms;
}
