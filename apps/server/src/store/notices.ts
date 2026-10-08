import type Database from "better-sqlite3";
import { z } from "zod";

/** Where the owner's marks live: one JSON value in the settings table the ops watch already uses for such state. */
const KEY = "notices.read";

const MarksSchema = z.object({
  /** Everything at or before this time is read. */
  seen: z.string().optional(),
  /** Rows read one by one, with the time they were read (to forget them after a week). */
  rows: z.record(z.string(), z.string()).default({}),
  /** When a sign-in decision was first seen: its own time is its last health check, which never stops moving. */
  firstSeen: z.record(z.string(), z.string()).default({}),
});
type Marks = z.infer<typeof MarksSchema>;

export interface ClientLine {
  room: string;
  item: string;
  type: string;
  at: string;
  payload: string;
  title: string;
  org: string | null;
  notify: string | null;
}

export interface TaskStatusRow {
  id: string;
  title: string;
  org: string | null;
  status: string;
  event: number;
  at: string;
  actor: string;
  hold: string | null;
}

export interface BugRow {
  id: string;
  title: string;
  org: string | null;
  at: string;
}

export interface IncidentRow {
  id: number;
  org: string;
  title: string;
  severity: string;
  service: string | null;
  openedAt: string;
  resolvedAt: string | null;
}

/**
 * What the bell reads from the database. Every query is bounded by a time and a row limit and runs on
 * an existing index: client lines on `(task, type, at)`, a task's last status change on
 * `task_events (task, id)`. Tasks and incidents are small tables read by one filter. The owner's marks
 * live in one `ops_settings` value.
 */
export class NoticesRepo {
  constructor(private readonly db: Database.Database) {}

  private load(): Marks {
    const row = this.db.prepare("SELECT value FROM ops_settings WHERE key = ?").get(KEY) as
      | { value: string }
      | undefined;
    if (row === undefined) return { rows: {}, firstSeen: {} };
    try {
      const parsed = MarksSchema.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : { rows: {}, firstSeen: {} };
    } catch {
      return { rows: {}, firstSeen: {} };
    }
  }

  private save(marks: Marks): void {
    this.db
      .prepare(
        "INSERT INTO ops_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(KEY, JSON.stringify(marks));
  }

  /** The "seen up to" time, and the rows read one by one. */
  marks(): { seen: string | undefined; rows: Set<string> } {
    const { seen, rows } = this.load();
    return { seen, rows: new Set(Object.keys(rows)) };
  }

  /** The time each of these ids was first seen, noting the new ones and forgetting the ids no longer listed. */
  firstSeen(ids: readonly string[], now: string): Map<string, string> {
    const marks = this.load();
    const next: Record<string, string> = {};
    for (const id of ids) next[id] = marks.firstSeen[id] ?? now;
    const same =
      Object.keys(next).length === Object.keys(marks.firstSeen).length &&
      Object.entries(next).every(([id, at]) => marks.firstSeen[id] === at);
    if (!same) this.save({ ...marks, firstSeen: next });
    return new Map(Object.entries(next));
  }

  /** Moves the "seen up to" time forward. It never moves back. */
  markSeen(upTo: string): void {
    const marks = this.load();
    if (marks.seen !== undefined && marks.seen >= upTo) return;
    this.save({ ...marks, seen: upTo });
  }

  /** Marks rows read, and forgets the rows read before `forgetBefore`: the seen mark covers them by then. */
  markRows(ids: readonly string[], now: string, forgetBefore: string): void {
    const marks = this.load();
    const rows = Object.fromEntries(Object.entries(marks.rows).filter(([, at]) => at >= forgetBefore));
    for (const id of ids) rows[id] ??= now;
    this.save({ ...marks, rows });
  }

  /** Client messages and the replies sent to clients, in client rooms, newest first. */
  clientLines(since: string, limit: number): ClientLine[] {
    return this.db
      .prepare(
        `SELECT r.task AS room, r.id AS item, r.type AS type, r.at AS at, r.payload AS payload,
                t.title AS title, t.org AS org, json_extract(t.client, '$.notify') AS notify
           FROM tasks t JOIN room_items r ON r.task = t.id
          WHERE t.client IS NOT NULL AND r.type IN ('client', 'client-reply') AND r.at >= ?
          ORDER BY r.at DESC LIMIT ?`,
      )
      .all(since, limit) as ClientLine[];
  }

  /**
   * Tasks that are in review, done or paused now, with the event that put them there. A task that
   * moved on has no row: the feed says what is true.
   */
  taskStatuses(since: string, limit: number): TaskStatusRow[] {
    return this.db
      .prepare(
        `SELECT t.id AS id, t.title AS title, t.org AS org, t.status AS status,
                e.id AS event, e.at AS at, e.actor AS actor, e.hold AS hold
           FROM tasks t
           JOIN task_events e ON e.id = (
                  SELECT max(id) FROM task_events
                   WHERE task = t.id AND refused = 0 AND to_status = t.status
                     AND coalesce(from_status, '') != to_status)
          WHERE t.updated_at >= ? AND t.status IN ('review', 'done', 'paused') AND t.kind != 'chat'
            AND e.at >= ?
          ORDER BY e.at DESC LIMIT ?`,
      )
      .all(since, since, limit) as TaskStatusRow[];
  }

  /** Tasks the captain filed as bugs. */
  captainBugs(since: string, limit: number): BugRow[] {
    return this.db
      .prepare(
        `SELECT id, title, org, created_at AS at FROM tasks
          WHERE type = 'bug' AND type_by = 'captain' AND created_at >= ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(since, limit) as BugRow[];
  }

  /** Incidents opened or resolved since a time. */
  incidents(since: string, limit: number): IncidentRow[] {
    return this.db
      .prepare(
        `SELECT id, org, title, severity, service, opened_at AS openedAt, resolved_at AS resolvedAt
           FROM ops_incidents WHERE opened_at >= ? OR resolved_at >= ?
          ORDER BY id DESC LIMIT ?`,
      )
      .all(since, since, limit) as IncidentRow[];
  }
}
