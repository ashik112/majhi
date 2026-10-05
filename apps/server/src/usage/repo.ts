import {
  type CostSource,
  EMPTY_TOTALS,
  type TurnRow,
  type UsageDimension,
  type UsageFilters,
  type UsageTotals,
} from "@majhi/shared";
import type Database from "better-sqlite3";

/** One turn as it is written. */
export interface NewTurn {
  at: string;
  task: string;
  agent: string;
  account: string;
  tool: string;
  auth: string;
  org: string | null;
  project: string | null;
  runId: number | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  costSource: CostSource;
  estimated: boolean;
}

/** Which rows: the filters, and a UTC span (`start` inclusive, `end` exclusive). */
export interface TurnQuery {
  filters: UsageFilters;
  start?: string | undefined;
  end?: string | undefined;
}

/** Columns a filter or a group may use. Never built from input. */
const COLUMN: Record<keyof UsageFilters, string> = {
  org: "org",
  project: "project",
  agent: "agent",
  account: "account",
  model: "model",
  task: "task",
};

const SUMS = `COUNT(*) AS turns,
  COALESCE(SUM(input_tokens), 0) AS input,
  COALESCE(SUM(output_tokens), 0) AS output,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
  COALESCE(SUM(cost_usd), 0) AS cost,
  COALESCE(SUM(CASE WHEN estimated = 1 THEN cost_usd ELSE 0 END), 0) AS estimated_cost,
  COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced`;

interface SumRow {
  turns: number;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  estimated_cost: number;
  unpriced: number;
}

/** Sums of floats drift in the last digits; a millionth of a dollar is plenty. */
function money(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function totalsOf(r: SumRow | undefined): UsageTotals {
  if (r === undefined || r.turns === 0) return { ...EMPTY_TOTALS };
  return {
    turns: r.turns,
    inputTokens: r.input,
    outputTokens: r.output,
    reasoningTokens: r.reasoning,
    cacheReadTokens: r.cache_read,
    cacheWriteTokens: r.cache_write,
    totalTokens: r.input + r.output + r.cache_read + r.cache_write,
    costUsd: money(r.cost),
    estimatedUsd: money(r.estimated_cost),
    unpricedTurns: r.unpriced,
  };
}

function where(q: TurnQuery): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  for (const [key, value] of Object.entries(q.filters) as [keyof UsageFilters, string | undefined][]) {
    if (value === undefined) continue;
    clauses.push(`turns.${COLUMN[key]} = ?`);
    params.push(value);
  }
  if (q.start !== undefined) {
    clauses.push("turns.at >= ?");
    params.push(q.start);
  }
  if (q.end !== undefined) {
    clauses.push("turns.at < ?");
    params.push(q.end);
  }
  return { sql: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

export interface DayRow {
  at: string;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  cost: number | null;
  estimated: number;
}

/** Adds one row to running totals, in place. */
export function addRow(t: UsageTotals, r: DayRow): void {
  t.turns += 1;
  t.inputTokens += r.input;
  t.outputTokens += r.output;
  t.reasoningTokens += r.reasoning;
  t.cacheReadTokens += r.cache_read;
  t.cacheWriteTokens += r.cache_write;
  t.totalTokens += r.input + r.output + r.cache_read + r.cache_write;
  if (r.cost === null) t.unpricedTurns += 1;
  else {
    t.costUsd = money(t.costUsd + r.cost);
    if (r.estimated === 1) t.estimatedUsd = money(t.estimatedUsd + r.cost);
  }
}

interface TurnDbRow {
  id: number;
  at: string;
  task: string;
  agent: string;
  account: string;
  org: string | null;
  project: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  cost_source: CostSource;
  estimated: number;
}

/** The `turns` table: writes one row per turn, and sums them. */
export class UsageRepo {
  private readonly insertStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO turns (at, task, agent, account, tool, auth, org, project, run_id, model,
        input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, cost_source, estimated)
       VALUES (@at, @task, @agent, @account, @tool, @auth, @org, @project, @runId, @model,
        @inputTokens, @outputTokens, @reasoningTokens, @cacheReadTokens, @cacheWriteTokens,
        @costUsd, @costSource, @estimated)`,
    );
  }

  insert(turn: NewTurn): number {
    const res = this.insertStmt.run({ ...turn, estimated: turn.estimated ? 1 : 0 });
    return Number(res.lastInsertRowid);
  }

  /** The id of the agent's last finished turn in the task, 0 when it had none. */
  lastTurnId(task: string, agent: string): number {
    const row = this.db
      .prepare("SELECT MAX(id) AS id FROM turns WHERE task = ? AND agent = ?")
      .get(task, agent) as { id: number | null };
    return row.id ?? 0;
  }

  totals(q: TurnQuery): UsageTotals {
    const w = where(q);
    return totalsOf(this.db.prepare(`SELECT ${SUMS} FROM turns ${w.sql}`).get(...w.params) as SumRow);
  }

  /**
   * Totals per value of one column, most expensive first, then most tokens. Tasks carry their
   * title. `day` is grouped by the caller, which knows the time zone.
   */
  groups(
    by: Exclude<UsageDimension, "day">,
    q: TurnQuery,
    limit: number,
  ): { key: string | null; title: string | null; org: string | null; totals: UsageTotals }[] {
    const w = where(q);
    const column = `turns.${COLUMN[by]}`;
    const title = by === "task" ? "MAX(tasks.title)" : "NULL";
    const join = by === "task" ? "LEFT JOIN tasks ON tasks.id = turns.task" : "";
    const rows = this.db
      .prepare(
        `SELECT ${column} AS key, ${title} AS title, MAX(turns.org) AS org, ${SUMS}
         FROM turns ${join} ${w.sql}
         GROUP BY ${column}
         ORDER BY cost DESC, (input + output + cache_read + cache_write) DESC, key ASC
         LIMIT ?`,
      )
      .all(...w.params, limit) as (SumRow & {
      key: string | null;
      title: string | null;
      org: string | null;
    })[];
    return rows.map((r) => ({ key: r.key, title: r.title, org: r.org, totals: totalsOf(r) }));
  }

  /** Every matching turn's numbers, oldest first, for totals per local day. */
  forDays(q: TurnQuery): DayRow[] {
    const w = where(q);
    return this.db
      .prepare(
        `SELECT at, input_tokens AS input, output_tokens AS output, reasoning_tokens AS reasoning,
           cache_read_tokens AS cache_read, cache_write_tokens AS cache_write, cost_usd AS cost, estimated
         FROM turns ${w.sql} ORDER BY at ASC`,
      )
      .all(...w.params) as DayRow[];
  }

  /** The time of the oldest matching turn. */
  firstAt(q: TurnQuery): string | undefined {
    const w = where(q);
    const row = this.db.prepare(`SELECT MIN(at) AS at FROM turns ${w.sql}`).get(...w.params) as
      | { at: string | null }
      | undefined;
    return row?.at ?? undefined;
  }

  /** Newest first. */
  list(q: TurnQuery, limit: number): TurnRow[] {
    const w = where(q);
    const rows = this.db
      .prepare(`SELECT * FROM turns ${w.sql} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...w.params, limit) as TurnDbRow[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      task: r.task,
      agent: r.agent,
      account: r.account,
      org: r.org,
      project: r.project,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      reasoningTokens: r.reasoning_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      costUsd: r.cost_usd,
      costSource: r.cost_source,
      estimated: r.estimated === 1,
    }));
  }
}
