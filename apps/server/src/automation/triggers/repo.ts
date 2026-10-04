import {
  type AutomationAction,
  AutomationActionSchema,
  type OverlapPolicy,
  type WatchSpec,
  WatchSpecSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";

/** What a trigger last saw: each thing it watches (a task, a process, or "" for one thing) and its state. */
export type Baseline = Record<string, string>;

export interface TriggerRow {
  id: string;
  org: string;
  name: string;
  watch: WatchSpec;
  action: AutomationAction;
  overlap: OverlapPolicy;
  paused: boolean;
  /** Null: the default for the kind of watch. */
  pollSeconds: number | null;
  settleSeconds: number;
  cooldownSeconds: number;
  /** Null until the first check. */
  baseline: Baseline | null;
  lastFiredAt: string | null;
  lastRunId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  org: string;
  name: string;
  watch: string;
  action: string;
  overlap: OverlapPolicy;
  paused: number;
  poll_seconds: number | null;
  settle_seconds: number;
  cooldown_seconds: number;
  baseline: string | null;
  last_fired_at: string | null;
  last_run_id: number | null;
  created_at: string;
  updated_at: string;
}

/** What `update` may change. `undefined` leaves a column alone; `null` clears a nullable one. */
export type TriggerPatch = Partial<
  Pick<
    TriggerRow,
    | "name"
    | "watch"
    | "action"
    | "overlap"
    | "paused"
    | "pollSeconds"
    | "settleSeconds"
    | "cooldownSeconds"
    | "baseline"
    | "lastFiredAt"
    | "lastRunId"
  >
>;

function toRow(r: Row): TriggerRow | undefined {
  // A row that no longer parses (from an older build) is left out rather than crashing the loop.
  const watch = WatchSpecSchema.safeParse(JSON.parse(r.watch));
  const action = AutomationActionSchema.safeParse(JSON.parse(r.action));
  if (!watch.success || !action.success) return undefined;
  return {
    id: r.id,
    org: r.org,
    name: r.name,
    watch: watch.data,
    action: action.data,
    overlap: r.overlap,
    paused: r.paused === 1,
    pollSeconds: r.poll_seconds,
    settleSeconds: r.settle_seconds,
    cooldownSeconds: r.cooldown_seconds,
    baseline: r.baseline === null ? null : (JSON.parse(r.baseline) as Baseline),
    lastFiredAt: r.last_fired_at,
    lastRunId: r.last_run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS: Record<keyof TriggerPatch, string> = {
  name: "name",
  watch: "watch",
  action: "action",
  overlap: "overlap",
  paused: "paused",
  pollSeconds: "poll_seconds",
  settleSeconds: "settle_seconds",
  cooldownSeconds: "cooldown_seconds",
  baseline: "baseline",
  lastFiredAt: "last_fired_at",
  lastRunId: "last_run_id",
};

/** The `triggers` table. A trigger copied to a watch (`migrated_to` set) no longer shows or runs here. */
export class TriggerRepo {
  constructor(private readonly db: Database.Database) {}

  insert(row: TriggerRow): void {
    this.db
      .prepare(
        `INSERT INTO triggers
           (id, org, name, watch, action, overlap, paused, poll_seconds, settle_seconds, cooldown_seconds,
            baseline, last_fired_at, last_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.org,
        row.name,
        JSON.stringify(row.watch),
        JSON.stringify(row.action),
        row.overlap,
        row.paused ? 1 : 0,
        row.pollSeconds,
        row.settleSeconds,
        row.cooldownSeconds,
        row.baseline === null ? null : JSON.stringify(row.baseline),
        row.lastFiredAt,
        row.lastRunId,
        row.createdAt,
        row.updatedAt,
      );
  }

  get(id: string): TriggerRow | undefined {
    const row = this.db.prepare("SELECT * FROM triggers WHERE id = ? AND migrated_to IS NULL").get(id) as
      | Row
      | undefined;
    return row === undefined ? undefined : toRow(row);
  }

  /** Oldest first, optionally for one org. */
  list(org?: string): TriggerRow[] {
    const rows =
      org === undefined
        ? (this.db
            .prepare("SELECT * FROM triggers WHERE migrated_to IS NULL ORDER BY created_at, id")
            .all() as Row[])
        : (this.db
            .prepare("SELECT * FROM triggers WHERE org = ? AND migrated_to IS NULL ORDER BY created_at, id")
            .all(org) as Row[]);
    return rows.flatMap((r) => toRow(r) ?? []);
  }

  /** Triggers that are checking: not paused. */
  active(): TriggerRow[] {
    return (
      this.db
        .prepare("SELECT * FROM triggers WHERE paused = 0 AND migrated_to IS NULL ORDER BY created_at, id")
        .all() as Row[]
    ).flatMap((r) => toRow(r) ?? []);
  }

  /** `updatedAt` is left out for what the engine keeps up (its baseline, its last run): they are not edits. */
  update(id: string, patch: TriggerPatch, updatedAt?: string): void {
    const sets: string[] = updatedAt === undefined ? [] : ["updated_at = ?"];
    const values: unknown[] = updatedAt === undefined ? [] : [updatedAt];
    if (sets.length === 0 && Object.values(patch).every((v) => v === undefined)) return;
    for (const key of Object.keys(COLUMNS) as (keyof TriggerPatch)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${COLUMNS[key]} = ?`);
      values.push(
        key === "watch" || key === "action" || key === "baseline"
          ? value === null
            ? null
            : JSON.stringify(value)
          : typeof value === "boolean"
            ? Number(value)
            : value,
      );
    }
    this.db.prepare(`UPDATE triggers SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
  }
}
