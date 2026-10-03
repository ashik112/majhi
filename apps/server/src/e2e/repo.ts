import { type E2eRun, E2eRunSchema, type E2eRunStatus } from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";

/** A trace the helper kept, relative to the majhi folder. */
export interface E2eTrace {
  spec: string;
  file: string;
}

/** A red main, from the run that found it to the first green one. One task per break. */
export interface E2eBreak {
  id: number;
  project: string;
  task: string;
  firstRun: string;
  firstCommit: string;
  lastGreen?: string;
  openedAt: string;
  closedAt?: string;
}

interface RunRow {
  id: string;
  project: string;
  commit_sha: string;
  subject: string | null;
  task: string | null;
  status: string;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  passed: number | null;
  failed: number | null;
  failed_specs: string;
  traces: string;
  error: string | null;
  break_task: string | null;
}

interface BreakRow {
  id: number;
  project: string;
  task: string;
  first_run: string;
  first_commit: string;
  last_green: string | null;
  opened_at: string;
  closed_at: string | null;
}

const StringList = z.array(z.string()).catch([]);
const TraceList = z.array(z.object({ spec: z.string(), file: z.string() })).catch([]);

const FINISHED = "('passed', 'failed', 'errored')";

const optional = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } =>
  (value === null ? {} : { [key]: value }) as { [P in K]?: V };

function runOf(r: RunRow): E2eRun {
  return E2eRunSchema.parse({
    id: r.id,
    project: r.project,
    commit: r.commit_sha,
    ...optional("subject", r.subject),
    ...optional("task", r.task),
    status: r.status,
    queuedAt: r.queued_at,
    ...optional("startedAt", r.started_at),
    ...optional("finishedAt", r.finished_at),
    ...optional("durationMs", r.duration_ms),
    ...optional("passed", r.passed),
    ...optional("failed", r.failed),
    failedSpecs: StringList.parse(safeJson(r.failed_specs)),
    ...optional("error", r.error),
    ...optional("breakTask", r.break_task),
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

function breakOf(r: BreakRow): E2eBreak {
  return {
    id: r.id,
    project: r.project,
    task: r.task,
    firstRun: r.first_run,
    firstCommit: r.first_commit,
    ...optional("lastGreen", r.last_green),
    openedAt: r.opened_at,
    ...optional("closedAt", r.closed_at),
  };
}

/** The tables of migration 113: runs, breaks, and the base-branch tip last seen per project. */
export class E2eRepo {
  constructor(private readonly db: Database.Database) {}

  insertRun(run: {
    id: string;
    project: string;
    commit: string;
    subject?: string;
    task?: string;
    at: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO e2e_runs (id, project, commit_sha, subject, task, status, queued_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
      )
      .run(run.id, run.project, run.commit, run.subject ?? null, run.task ?? null, run.at);
  }

  getRun(id: string): E2eRun | undefined {
    const row = this.db.prepare("SELECT * FROM e2e_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row === undefined ? undefined : runOf(row);
  }

  /** The run of this project at this commit, unless a newer merge replaced it. */
  runAt(project: string, commit: string): E2eRun | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM e2e_runs WHERE project = ? AND commit_sha = ? AND status != 'replaced' ORDER BY queued_at DESC LIMIT 1",
      )
      .get(project, commit) as RunRow | undefined;
    return row === undefined ? undefined : runOf(row);
  }

  setStatus(id: string, status: E2eRunStatus, fields: { at?: string; error?: string } = {}): void {
    if (status === "running") {
      this.db
        .prepare("UPDATE e2e_runs SET status = ?, started_at = ? WHERE id = ?")
        .run(status, fields.at ?? null, id);
      return;
    }
    this.db
      .prepare("UPDATE e2e_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(status, fields.at ?? null, fields.error ?? null, id);
  }

  finish(
    id: string,
    result: {
      status: "passed" | "failed" | "errored";
      at: string;
      durationMs: number;
      passed: number;
      failed: number;
      failedSpecs: string[];
      traces: E2eTrace[];
      error?: string | undefined;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE e2e_runs SET status = ?, finished_at = ?, duration_ms = ?, passed = ?, failed = ?,
           failed_specs = ?, traces = ?, error = ? WHERE id = ?`,
      )
      .run(
        result.status,
        result.at,
        result.durationMs,
        result.passed,
        result.failed,
        JSON.stringify(result.failedSpecs),
        JSON.stringify(result.traces),
        result.error ?? null,
        id,
      );
  }

  setBreakTask(id: string, task: string): void {
    this.db.prepare("UPDATE e2e_runs SET break_task = ? WHERE id = ?").run(task, id);
  }

  traces(id: string): E2eTrace[] {
    const row = this.db.prepare("SELECT traces FROM e2e_runs WHERE id = ?").get(id) as
      | { traces: string }
      | undefined;
    return row === undefined ? [] : TraceList.parse(safeJson(row.traces));
  }

  running(): E2eRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM e2e_runs WHERE status = 'running' ORDER BY queued_at LIMIT 1")
      .get() as RunRow | undefined;
    return row === undefined ? undefined : runOf(row);
  }

  queued(): E2eRun[] {
    return (
      this.db
        .prepare("SELECT * FROM e2e_runs WHERE status = 'queued' ORDER BY queued_at, rowid")
        .all() as RunRow[]
    ).map(runOf);
  }

  /** Runs that were queued or running when majhi stopped: the helper's answer to them is lost. */
  unfinished(): E2eRun[] {
    return (
      this.db
        .prepare("SELECT * FROM e2e_runs WHERE status IN ('queued', 'running') ORDER BY queued_at")
        .all() as RunRow[]
    ).map(runOf);
  }

  /** The newest finished run of each project. */
  latestPerProject(): E2eRun[] {
    return (
      this.db
        .prepare(
          `SELECT r.* FROM e2e_runs r
           WHERE r.status IN ${FINISHED}
             AND r.rowid = (SELECT x.rowid FROM e2e_runs x WHERE x.project = r.project AND x.status IN ${FINISHED}
                            ORDER BY x.finished_at DESC, x.rowid DESC LIMIT 1)
           ORDER BY r.project`,
        )
        .all() as RunRow[]
    ).map(runOf);
  }

  recent(limit: number): E2eRun[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM e2e_runs WHERE status IN ${FINISHED} ORDER BY finished_at DESC, rowid DESC LIMIT ?`,
        )
        .all(limit) as RunRow[]
    ).map(runOf);
  }

  /** The project's newest finished run. */
  lastFinished(project: string): E2eRun | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM e2e_runs WHERE project = ? AND status IN ${FINISHED} ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
      )
      .get(project) as RunRow | undefined;
    return row === undefined ? undefined : runOf(row);
  }

  /** Whether any run of the project was queued at or after `at` (an ISO time). */
  queuedSince(project: string, at: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM e2e_runs WHERE project = ? AND queued_at >= ? LIMIT 1")
        .get(project, at) !== undefined
    );
  }

  /** The commit of the project's newest passed run. */
  lastGreen(project: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT commit_sha FROM e2e_runs WHERE project = ? AND status = 'passed' ORDER BY finished_at DESC, rowid DESC LIMIT 1",
      )
      .get(project) as { commit_sha: string } | undefined;
    return row?.commit_sha;
  }

  seen(project: string): string | undefined {
    const row = this.db.prepare("SELECT commit_sha FROM e2e_seen WHERE project = ?").get(project) as
      | { commit_sha: string }
      | undefined;
    return row?.commit_sha;
  }

  setSeen(project: string, commit: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO e2e_seen (project, commit_sha, seen_at) VALUES (?, ?, ?)
         ON CONFLICT (project) DO UPDATE SET commit_sha = excluded.commit_sha, seen_at = excluded.seen_at`,
      )
      .run(project, commit, at);
  }

  openBreak(project: string): E2eBreak | undefined {
    const row = this.db
      .prepare("SELECT * FROM e2e_breaks WHERE project = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(project) as BreakRow | undefined;
    return row === undefined ? undefined : breakOf(row);
  }

  insertBreak(b: Omit<E2eBreak, "id" | "closedAt">): number {
    const info = this.db
      .prepare(
        "INSERT INTO e2e_breaks (project, task, first_run, first_commit, last_green, opened_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(b.project, b.task, b.firstRun, b.firstCommit, b.lastGreen ?? null, b.openedAt);
    return Number(info.lastInsertRowid);
  }

  closeBreak(id: number, at: string): void {
    this.db.prepare("UPDATE e2e_breaks SET closed_at = ? WHERE id = ?").run(at, id);
  }
}
