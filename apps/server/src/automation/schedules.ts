import {
  type AutomationAction,
  AutomationActionSchema,
  type OverlapPolicy,
  type ScheduleSpec,
  ScheduleSpecSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";

export interface ScheduleRow {
  id: string;
  org: string;
  name: string;
  spec: ScheduleSpec;
  timeZone: string;
  action: AutomationAction;
  overlap: OverlapPolicy;
  paused: boolean;
  /** A `once` schedule that has run. */
  done: boolean;
  /** UTC ISO. Null when paused or done. */
  nextRunAt: string | null;
  lastRunId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  org: string;
  name: string;
  spec: string;
  time_zone: string;
  action: string;
  overlap: OverlapPolicy;
  paused: number;
  done: number;
  next_run_at: string | null;
  last_run_id: number | null;
  created_at: string;
  updated_at: string;
}

/** What `update` may change. `undefined` leaves a column alone. */
export type SchedulePatch = Partial<
  Pick<
    ScheduleRow,
    "name" | "spec" | "timeZone" | "action" | "overlap" | "paused" | "done" | "nextRunAt" | "lastRunId"
  >
>;

function toRow(r: Row): ScheduleRow | undefined {
  // A row that no longer parses (a spec from an older build) is left out rather than crashing the loop.
  const spec = ScheduleSpecSchema.safeParse(JSON.parse(r.spec));
  const action = AutomationActionSchema.safeParse(JSON.parse(r.action));
  if (!spec.success || !action.success) return undefined;
  return {
    id: r.id,
    org: r.org,
    name: r.name,
    spec: spec.data,
    timeZone: r.time_zone,
    action: action.data,
    overlap: r.overlap,
    paused: r.paused === 1,
    done: r.done === 1,
    nextRunAt: r.next_run_at,
    lastRunId: r.last_run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The `schedules` table. */
export class ScheduleRepo {
  constructor(private readonly db: Database.Database) {}

  insert(row: ScheduleRow): void {
    this.db
      .prepare(
        `INSERT INTO schedules
           (id, org, name, spec, time_zone, action, overlap, paused, done, next_run_at, last_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.org,
        row.name,
        JSON.stringify(row.spec),
        row.timeZone,
        JSON.stringify(row.action),
        row.overlap,
        row.paused ? 1 : 0,
        row.done ? 1 : 0,
        row.nextRunAt,
        row.lastRunId,
        row.createdAt,
        row.updatedAt,
      );
  }

  get(id: string): ScheduleRow | undefined {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toRow(row);
  }

  /** Oldest first, optionally for one org. */
  list(org?: string): ScheduleRow[] {
    const rows =
      org === undefined
        ? (this.db.prepare("SELECT * FROM schedules ORDER BY created_at, id").all() as Row[])
        : (this.db
            .prepare("SELECT * FROM schedules WHERE org = ? ORDER BY created_at, id")
            .all(org) as Row[]);
    return rows.flatMap((r) => toRow(r) ?? []);
  }

  update(id: string, patch: SchedulePatch, updatedAt: string): void {
    const columns: Record<keyof SchedulePatch, string> = {
      name: "name",
      spec: "spec",
      timeZone: "time_zone",
      action: "action",
      overlap: "overlap",
      paused: "paused",
      done: "done",
      nextRunAt: "next_run_at",
      lastRunId: "last_run_id",
    };
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [updatedAt];
    for (const key of Object.keys(columns) as (keyof SchedulePatch)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${columns[key]} = ?`);
      values.push(
        key === "spec" || key === "action"
          ? JSON.stringify(value)
          : typeof value === "boolean"
            ? Number(value)
            : value,
      );
    }
    this.db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  /** Schedules that should have run by `now`: active, with a next run at or before it. */
  due(now: string): ScheduleRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM schedules WHERE paused = 0 AND done = 0 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id",
        )
        .all(now) as Row[]
    ).flatMap((r) => toRow(r) ?? []);
  }

  /** The earliest next run of any active schedule, or undefined when none is waiting. */
  earliest(): string | undefined {
    const row = this.db
      .prepare(
        "SELECT MIN(next_run_at) AS at FROM schedules WHERE paused = 0 AND done = 0 AND next_run_at IS NOT NULL",
      )
      .get() as { at: string | null };
    return row.at ?? undefined;
  }
}
