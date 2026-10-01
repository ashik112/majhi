import type Database from "better-sqlite3";
import type { DecisionRow, EventRow } from "./receipt.ts";

/** A UTC span: `start` inclusive, `end` exclusive. */
export interface Span {
  start?: string | undefined;
  end?: string | undefined;
}

/** The `usage_events` table: what majhi put into a context, for the token receipts. */
export class UsageEvents {
  private readonly insertEvent: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertEvent = db.prepare(
      `INSERT OR IGNORE INTO usage_events (at, task, agent, kind, tokens, after_tokens, method)
       VALUES (@at, @task, @agent, @kind, @tokens, @after, @method)`,
    );
  }

  private add(e: {
    at: string;
    task: string;
    agent: string | null;
    kind: EventRow["kind"];
    tokens: number | null;
    after?: number | null;
    method?: string | null;
  }): boolean {
    try {
      return this.insertEvent.run({ after: null, method: null, ...e }).changes > 0;
    } catch {
      // A task deleted while its session ends: there is no receipt to keep.
      return false;
    }
  }

  /** The brief's size, once per task: later calls change nothing. True when this call recorded it. */
  recordBrief(task: string, agent: string, at: string, briefTokens: number, memoryTokens: number): boolean {
    const first = this.add({ at, task, agent, kind: "brief", tokens: briefTokens });
    if (first) this.add({ at, task, agent, kind: "memory", tokens: memoryTokens });
    return first;
  }

  recordRecall(task: string, agent: string, at: string, tokens: number): void {
    this.add({ at, task, agent, kind: "recall", tokens });
  }

  recordCompaction(e: {
    task: string;
    agent: string;
    at: string;
    method: string;
    before?: number | undefined;
    after?: number | undefined;
  }): void {
    this.add({
      at: e.at,
      task: e.task,
      agent: e.agent,
      kind: "compaction",
      tokens: e.before ?? null,
      after: e.after ?? null,
      method: e.method,
    });
  }

  forTask(task: string): EventRow[] {
    return this.db
      .prepare(
        "SELECT at, agent, kind, tokens, after_tokens, method FROM usage_events WHERE task = ? ORDER BY id",
      )
      .all(task) as EventRow[];
  }

  forAgent(agent: string, span: Span): EventRow[] {
    const { sql, params } = spanSql(span, "usage_events.at");
    return this.db
      .prepare(
        `SELECT at, agent, kind, tokens, after_tokens, method FROM usage_events WHERE agent = ?${sql} ORDER BY id`,
      )
      .all(agent, ...params) as EventRow[];
  }

  decisionsForTask(task: string): DecisionRow[] {
    return this.db
      .prepare("SELECT provider, answers FROM decisions WHERE task = ?")
      .all(task) as DecisionRow[];
  }

  decisionsForAgent(agent: string, span: Span): DecisionRow[] {
    const { sql, params } = spanSql(span, "at");
    return this.db
      .prepare(`SELECT provider, answers FROM decisions WHERE agent = ?${sql}`)
      .all(agent, ...params) as DecisionRow[];
  }

  title(task: string): string | null {
    const row = this.db.prepare("SELECT title FROM tasks WHERE id = ?").get(task) as
      | { title: string }
      | undefined;
    return row?.title ?? null;
  }

  /** Distinct tasks an agent has turns in, within the span. */
  taskCount(agent: string, span: Span): number {
    const { sql, params } = spanSql(span, "at");
    const row = this.db
      .prepare(`SELECT COUNT(DISTINCT task) AS n FROM turns WHERE agent = ?${sql}`)
      .get(agent, ...params) as { n: number };
    return row.n;
  }
}

function spanSql(span: Span, column: string): { sql: string; params: string[] } {
  const params: string[] = [];
  let sql = "";
  if (span.start !== undefined) {
    sql += ` AND ${column} >= ?`;
    params.push(span.start);
  }
  if (span.end !== undefined) {
    sql += ` AND ${column} < ?`;
    params.push(span.end);
  }
  return { sql, params };
}
