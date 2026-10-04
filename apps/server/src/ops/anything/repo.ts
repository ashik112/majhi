import { type WatchDef, WatchDefSchema, type WatchSample } from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";

/** What a watch remembers between looks. Small: numbers, one short display line and the fix bookkeeping. */
export const WatchStateSchema = z.object({
  lastAt: z.string().optional(),
  /** The last look could read a value. */
  readable: z.boolean().default(true),
  /** The last look's value is healthy (a website answered as expected). */
  healthy: z.boolean().default(true),
  number: z.number().optional(),
  /** The value as a row shows it. Built from numbers and fixed words, never from remote text. */
  display: z.string().default(""),
  /** The look before the one that changed it. */
  previous: z.string().optional(),
  /** Why the last look could not tell. A fixed phrase. */
  unavailable: z.string().optional(),
  breachSince: z.string().optional(),
  /** A signature (a number or a hash of the page's main text) the next look is compared with. */
  baseline: z.string().optional(),
  /** The alert is firing. */
  firing: z.boolean().default(false),
  firingSince: z.string().optional(),
  found: z.string().max(1200).optional(),
  link: z.object({ label: z.string(), url: z.string() }).optional(),
  /** A custom watch's last reported state. */
  reportedOk: z.boolean().optional(),
  quietUntil: z.string().optional(),
  quietKind: z.enum(["snooze", "maintenance"]).optional(),
  /** The incident the fix bookkeeping is for. One attempt per incident. */
  fix: z
    .object({
      incident: z.number().int(),
      /** What the owner has been asked, until answered. */
      proposal: z
        .object({
          text: z.string(),
          options: z.array(z.object({ id: z.string(), label: z.string(), fixes: z.array(z.string()) })),
        })
        .optional(),
      attemptedAt: z.string().optional(),
      done: z.array(z.string()).default([]),
      /** Not fixed by then: page the owner. */
      deadline: z.string().optional(),
      paged: z.boolean().default(false),
    })
    .optional(),
  lastCustomAt: z.string().optional(),
  /** When the action last fired, for the cooldown. */
  lastFiredAt: z.string().optional(),
  signature: z.string().optional(),
  /** A limit watch saw its percent at the limit: the next look under it is a reset. */
  limitHit: z.boolean().optional(),
  fails: z.number().int().default(0),
});
export type WatchState = z.infer<typeof WatchStateSchema>;

export interface StoredWatch {
  id: string;
  org: string;
  def: WatchDef;
  state: WatchState;
  paused: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  org: string;
  def: string;
  state: string;
  paused: number;
  created_at: string;
}

function json(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class WatchRepo {
  constructor(private readonly db: Database.Database) {}

  all(org?: string): StoredWatch[] {
    const rows = (
      org === undefined
        ? this.db.prepare("SELECT * FROM watches ORDER BY org, created_at, id").all()
        : this.db.prepare("SELECT * FROM watches WHERE org = ? ORDER BY created_at, id").all(org)
    ) as Row[];
    const out: StoredWatch[] = [];
    for (const r of rows) {
      const def = WatchDefSchema.safeParse(json(r.def));
      if (!def.success) continue;
      out.push({
        id: r.id,
        org: r.org,
        def: def.data,
        state: WatchStateSchema.safeParse(json(r.state)).data ?? WatchStateSchema.parse({}),
        paused: r.paused === 1,
        createdAt: r.created_at,
      });
    }
    return out;
  }

  get(id: string): StoredWatch | undefined {
    return this.all().find((w) => w.id === id);
  }

  save(w: StoredWatch): void {
    this.db
      .prepare(
        `INSERT INTO watches (id, org, def, state, paused, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET def = excluded.def, state = excluded.state, paused = excluded.paused`,
      )
      .run(w.id, w.org, JSON.stringify(w.def), JSON.stringify(w.state), w.paused ? 1 : 0, w.createdAt);
  }

  remove(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM watches WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM watch_samples WHERE watch = ?").run(id);
      this.db.prepare("DELETE FROM ops_state WHERE service = ?").run(id);
    })();
  }

  addSample(watch: string, at: string, v: number | undefined, ok: boolean): void {
    this.db
      .prepare("INSERT INTO watch_samples (watch, at, v, ok) VALUES (?, ?, ?, ?)")
      .run(watch, at, v ?? null, ok ? 1 : 0);
  }

  samples(watch: string, since: string): WatchSample[] {
    return (
      this.db
        .prepare("SELECT at, v, ok FROM watch_samples WHERE watch = ? AND at >= ? ORDER BY at")
        .all(watch, since) as { at: string; v: number | null; ok: number }[]
    ).map((r) => ({ at: r.at, v: r.v, ok: r.ok === 1 }));
  }

  /** Drops history past 90 days, and thins what is older than 2 days to one look an hour. */
  prune(now: Date): void {
    const day = 86_400_000;
    const old = new Date(now.getTime() - 90 * day).toISOString();
    const thin = new Date(now.getTime() - 2 * day).toISOString();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM watch_samples WHERE at < ?").run(old);
      this.db
        .prepare(
          `DELETE FROM watch_samples WHERE at < ? AND rowid NOT IN (
             SELECT MIN(rowid) FROM watch_samples WHERE at < ? GROUP BY watch, substr(at, 1, 13))`,
        )
        .run(thin, thin);
    })();
  }
}
