import type { AutomationRun, AutomationRunStatus, AutomationSourceKind } from "@majhi/shared";
import type Database from "better-sqlite3";

interface Row {
  id: number;
  source_kind: AutomationSourceKind;
  source_id: string;
  org: string;
  started_at: string;
  ended_at: string | null;
  status: AutomationRunStatus;
  detail: string;
  task_id: string | null;
  process_id: string | null;
}

export interface NewRun {
  sourceKind: AutomationSourceKind;
  sourceId: string;
  org: string;
  startedAt: string;
  status: AutomationRunStatus;
  detail: string;
  /** Set for a run that ends at once (`skipped`, or a failure before anything started). */
  endedAt?: string | undefined;
  taskId?: string | undefined;
  processId?: string | undefined;
}

function toRun(r: Row): AutomationRun {
  return {
    id: r.id,
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    org: r.org,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    detail: r.detail,
    taskId: r.task_id,
    processId: r.process_id,
  };
}

/**
 * Every run of every schedule and trigger, kept in `automation_runs`. Schedules and watch triggers
 * write their runs here the same way, and the same queries read them.
 */
export class RunHistory {
  constructor(private readonly db: Database.Database) {}

  add(run: NewRun): AutomationRun {
    const res = this.db
      .prepare(
        `INSERT INTO automation_runs
           (source_kind, source_id, org, started_at, ended_at, status, detail, task_id, process_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.sourceKind,
        run.sourceId,
        run.org,
        run.startedAt,
        run.endedAt ?? null,
        run.status,
        run.detail,
        run.taskId ?? null,
        run.processId ?? null,
      );
    return this.require(Number(res.lastInsertRowid));
  }

  /** Ends a run that was still going. A run that has ended stays as it is. */
  finish(id: number, status: "ok" | "failed", detail: string, endedAt: string): AutomationRun {
    this.db
      .prepare(
        "UPDATE automation_runs SET status = ?, detail = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL",
      )
      .run(status, detail, endedAt, id);
    return this.require(id);
  }

  /** Records what a run started, once it did. */
  started(
    id: number,
    started: { detail: string; taskId?: string | undefined; processId?: string | undefined },
  ) {
    this.db
      .prepare("UPDATE automation_runs SET detail = ?, task_id = ?, process_id = ? WHERE id = ?")
      .run(started.detail, started.taskId ?? null, started.processId ?? null, id);
  }

  get(id: number): AutomationRun | undefined {
    const row = this.db.prepare("SELECT * FROM automation_runs WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toRun(row);
  }

  /** A source's runs, newest first. */
  list(kind: AutomationSourceKind, sourceId: string, limit: number): AutomationRun[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM automation_runs WHERE source_kind = ? AND source_id = ? ORDER BY id DESC LIMIT ?",
        )
        .all(kind, sourceId, limit) as Row[]
    ).map(toRun);
  }

  /** Runs that have not ended: of one source, or of all. */
  running(source?: { kind: AutomationSourceKind; id: string }): AutomationRun[] {
    const rows =
      source === undefined
        ? (this.db.prepare("SELECT * FROM automation_runs WHERE ended_at IS NULL ORDER BY id").all() as Row[])
        : (this.db
            .prepare(
              "SELECT * FROM automation_runs WHERE ended_at IS NULL AND source_kind = ? AND source_id = ? ORDER BY id",
            )
            .all(source.kind, source.id) as Row[]);
    return rows.map(toRun);
  }

  /** The most recent run of each given source, by id. */
  last(kind: AutomationSourceKind, ids: readonly string[]): Map<string, AutomationRun> {
    const found = new Map<string, AutomationRun>();
    for (const id of ids) {
      const row = this.db
        .prepare(
          "SELECT * FROM automation_runs WHERE source_kind = ? AND source_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(kind, id) as Row | undefined;
      if (row !== undefined) found.set(id, toRun(row));
    }
    return found;
  }

  /** A deleted schedule or trigger takes its history with it. */
  deleteFor(kind: AutomationSourceKind, sourceId: string): void {
    this.db
      .prepare("DELETE FROM automation_runs WHERE source_kind = ? AND source_id = ?")
      .run(kind, sourceId);
  }

  private require(id: number): AutomationRun {
    const run = this.get(id);
    if (run === undefined) throw new Error(`Run ${id} is missing.`);
    return run;
  }
}
