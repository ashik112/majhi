import type Database from "better-sqlite3";

/**
 * How long each growing table keeps its rows. One place, so a number is easy to find and to argue with.
 * Days count back from the day the prune runs.
 *
 * The long ones are the owner's records: `audit` is the security log (what an agent was allowed and by
 * whom), `turns` is what the money questions are answered from, and the captain's log is what an undo
 * reads. The short ones are feeds and the bulk of a finished task's room.
 */
export const RETENTION = {
  /** Rows one DELETE removes. A prune is many small statements with the event loop free in between. */
  batchRows: 500,
  /** The security log. Kept a year. */
  auditDays: 365,
  /** Per-turn cost rows. Two years, so a year-on-year spend question still has its data. */
  turnsDays: 730,
  /** The autonomous-mode feed. */
  autonomyEventsDays: 180,
  /** Judged outputs. The ladder reads the last few and the scorecard a month or a year. */
  outcomesDays: 400,
  /** The captain's log with its undo data. */
  captainActionsDays: 365,
  /** Settled action keys. A key only has to outlive the state it guards. */
  captainKeysDays: 180,
  /** Ended captain, playbook and automation runs, except the newest of each kind (it drives the cadence). */
  endedRunsDays: 180,
  handoffHistoryDays: 180,
  usageEventsDays: 365,
  /**
   * Tool output, thoughts and context notes of a task that has been done this long. Messages, plans,
   * reviews and every card (approvals, permissions, questions) stay: an undo reads approvals, and the
   * owner reads the conversation.
   */
  doneRoomBulkDays: 90,
} as const;

/** Room item types that are bulk: large, rarely read after the task is done. */
const BULK_TYPES = ["tool", "thought", "context"] as const;

interface TableRule {
  table: string;
  /** What older than the cutoff means for this table: a SQL condition with one `?` for the cutoff. */
  where: string;
  days: number;
}

const DAY_MS = 86_400_000;

/** The age-based rules. Each condition keeps what is still needed (the newest run of a kind, an unsettled key). */
const RULES: readonly TableRule[] = [
  { table: "audit", where: "at < ?", days: RETENTION.auditDays },
  { table: "turns", where: "at < ?", days: RETENTION.turnsDays },
  { table: "autonomy_events", where: "at < ?", days: RETENTION.autonomyEventsDays },
  { table: "outcomes", where: "at < ?", days: RETENTION.outcomesDays },
  { table: "captain_actions", where: "at < ?", days: RETENTION.captainActionsDays },
  // An unsettled key is an action still running or crashed: it is taken over by its own rule, not pruned.
  { table: "captain_keys", where: "settled = 1 AND at < ?", days: RETENTION.captainKeysDays },
  {
    table: "captain_runs",
    where:
      "ended_at IS NOT NULL AND started_at < ? AND id NOT IN (SELECT max(id) FROM captain_runs GROUP BY org, chore)",
    days: RETENTION.endedRunsDays,
  },
  {
    table: "playbook_runs",
    where:
      "ended_at IS NOT NULL AND started_at < ? AND id NOT IN (SELECT max(id) FROM playbook_runs GROUP BY org, playbook)",
    days: RETENTION.endedRunsDays,
  },
  {
    table: "automation_runs",
    where:
      "ended_at IS NOT NULL AND started_at < ? AND id NOT IN (SELECT max(id) FROM automation_runs GROUP BY source_kind, source_id)",
    days: RETENTION.endedRunsDays,
  },
  { table: "handoff_history", where: "at < ?", days: RETENTION.handoffHistoryDays },
  { table: "usage_events", where: "at < ?", days: RETENTION.usageEventsDays },
];

export interface PruneResult {
  /** Rows deleted per table (`room_items` for the bulk of finished tasks). Tables that lost nothing are left out. */
  deleted: Record<string, number>;
  /** DELETE statements run: one per batch. */
  batches: number;
}

export interface PruneOptions {
  now?: Date;
  /** Rows per DELETE. Defaults to {@link RETENTION.batchRows}. */
  batchRows?: number;
  /** Called between batches; the default hands control back to the event loop. */
  yieldLoop?: () => Promise<void>;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Deletes what is past its retention, a small batch at a time with the event loop free in between, so a
 * big first prune never stalls requests. Safe to run any time and to run twice: it only removes rows
 * that are old enough, and what an undo, a resume or a pending card still needs is never old enough.
 */
export async function pruneOld(db: Database.Database, options: PruneOptions = {}): Promise<PruneResult> {
  const now = (options.now ?? new Date()).getTime();
  const batch = options.batchRows ?? RETENTION.batchRows;
  const pause = options.yieldLoop ?? yieldToLoop;
  const result: PruneResult = { deleted: {}, batches: 0 };
  const count = (table: string, n: number) => {
    if (n > 0) result.deleted[table] = (result.deleted[table] ?? 0) + n;
  };

  for (const rule of RULES) {
    const cutoff = new Date(now - rule.days * DAY_MS).toISOString();
    const del = db.prepare(
      `DELETE FROM ${rule.table} WHERE rowid IN (SELECT rowid FROM ${rule.table} WHERE ${rule.where} LIMIT ?)`,
    );
    for (;;) {
      const { changes } = del.run(cutoff, batch);
      result.batches += 1;
      count(rule.table, changes);
      if (changes < batch) break;
      await pause();
    }
    await pause();
  }

  // The bulk of finished tasks' rooms. Per task, newest item always stays (the room's `seq` counter is
  // read from it), and so does anything pending.
  const cutoff = new Date(now - RETENTION.doneRoomBulkDays * DAY_MS).toISOString();
  const doneTasks = db
    .prepare("SELECT id FROM tasks WHERE status = 'done' AND updated_at < ?")
    .all(cutoff) as { id: string }[];
  const marks = BULK_TYPES.map(() => "?").join(", ");
  const delRoom = db.prepare(
    `DELETE FROM room_items WHERE rowid IN (
       SELECT rowid FROM room_items
       WHERE task = ? AND type IN (${marks}) AND pending = 0
         AND seq < (SELECT max(seq) FROM room_items WHERE task = ?)
       LIMIT ?)`,
  );
  for (const { id } of doneTasks) {
    for (;;) {
      const { changes } = delRoom.run(id, ...BULK_TYPES, id, batch);
      result.batches += 1;
      count("room_items", changes);
      if (changes < batch) break;
      await pause();
    }
    await pause();
  }

  // Fresh statistics for the planner, and the WAL back to a small size after a big delete.
  if (result.batches > RULES.length + doneTasks.length) {
    db.pragma("optimize");
    db.pragma("wal_checkpoint(PASSIVE)");
  }
  return result;
}
