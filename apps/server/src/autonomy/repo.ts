import {
  type AutonomyEvent,
  type AutonomyEventKind,
  AutonomyEventSchema,
  type AutonomyHold,
  AutonomyHoldSchema,
  type AutonomyMode,
  AutonomyModeSchema,
  type AutonomySummary,
  AutonomySummarySchema,
  PRIVATE,
  type QueueItem,
  QueueItemSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { OrgSpendRow } from "./spend.ts";

/** The one row of autonomous mode's state (migration 112). */
export interface AutonomyState {
  mode: AutonomyMode;
  since?: string;
  by?: "owner" | "majhi";
  why?: string;
  /** The boss's autonomy chat. */
  chat?: string;
  queue: QueueItem[];
  queuedAt?: string;
  lastTick?: string;
  /** The holds seen last, so a restart writes no cap event for a hold it already wrote. */
  holds: AutonomyHold[];
}

export type HeldReason = "owner" | "limit";

export interface AutonomyTaskRow {
  task: string;
  since: string;
  held?: HeldReason;
  /** For `limit`: `day`, or the org whose cap held it. */
  heldScope?: string;
  /** When the owner last resumed it by hand. */
  resumedAt?: string;
  /** The boss's one-line reason for taking it on. */
  why?: string;
}

interface TaskDbRow {
  task: string;
  since: string;
  held: string | null;
  held_scope: string | null;
  resumed_at: string | null;
  why: string | null;
}

function taskOf(r: TaskDbRow): AutonomyTaskRow {
  return {
    task: r.task,
    since: r.since,
    ...(r.held === "owner" || r.held === "limit" ? { held: r.held } : {}),
    ...present("heldScope", r.held_scope),
    ...present("resumedAt", r.resumed_at),
    ...present("why", r.why),
  };
}

/** The kinds the "Decisions" list keeps. */
const DECISION_KINDS: readonly AutonomyEventKind[] = ["decision", "approval", "refused"];

type NewEvent = Omit<AutonomyEvent, "seq" | "at"> & { at: string };

interface StateDbRow {
  mode: string;
  since: string | null;
  changed_by: string | null;
  why: string | null;
  chat: string | null;
  queue: string;
  queued_at: string | null;
  last_tick: string | null;
  holds: string;
}

interface EventDbRow {
  seq: number;
  at: string;
  kind: string;
  text: string;
  reason: string | null;
  task: string | null;
  org: string | null;
  agent: string | null;
  command: string | null;
  outcome: string | null;
  unsure: number;
  item: string | null;
  status: string | null;
}

/** A JSON column read with a schema; anything that does not parse reads as `fallback`. */
function parsed<T>(json: string | null, schema: z.ZodType<T>, fallback: T): T {
  if (json === null) return fallback;
  try {
    const out = schema.safeParse(JSON.parse(json));
    return out.success ? out.data : fallback;
  } catch {
    return fallback;
  }
}

function present<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: V };
}

/** The autonomy tables in `majhi.db`: state, tasks, the feed and the daily summaries. */
export class AutonomyRepo {
  constructor(private readonly db: Database.Database) {}

  state(): AutonomyState {
    const row = this.db.prepare("SELECT * FROM autonomy_state WHERE id = 1").get() as StateDbRow | undefined;
    if (row === undefined) return { mode: "off", queue: [], holds: [] };
    const by: "owner" | "majhi" | null =
      row.changed_by === "owner" || row.changed_by === "majhi" ? row.changed_by : null;
    return {
      mode: AutonomyModeSchema.catch("off").parse(row.mode),
      ...present("since", row.since),
      ...present("by", by),
      ...present("why", row.why),
      ...present("chat", row.chat),
      queue: parsed(row.queue, z.array(QueueItemSchema), []),
      ...present("queuedAt", row.queued_at),
      ...present("lastTick", row.last_tick),
      holds: parsed(row.holds, z.array(AutonomyHoldSchema), []),
    };
  }

  setMode(mode: AutonomyMode, at: string, by: "owner" | "majhi", why: string | undefined): void {
    this.db
      .prepare("UPDATE autonomy_state SET mode = ?, since = ?, changed_by = ?, why = ? WHERE id = 1")
      .run(mode, at, by, why ?? null);
  }

  setChat(chat: string): void {
    this.db.prepare("UPDATE autonomy_state SET chat = ? WHERE id = 1").run(chat);
  }

  setQueue(items: readonly QueueItem[], at: string): void {
    this.db
      .prepare("UPDATE autonomy_state SET queue = ?, queued_at = ? WHERE id = 1")
      .run(JSON.stringify(items), at);
  }

  setLastTick(at: string): void {
    this.db.prepare("UPDATE autonomy_state SET last_tick = ? WHERE id = 1").run(at);
  }

  setHolds(holds: readonly AutonomyHold[]): void {
    this.db.prepare("UPDATE autonomy_state SET holds = ? WHERE id = 1").run(JSON.stringify(holds));
  }

  // ---------------------------------------------------------------------------
  // Autonomous tasks

  isAutonomous(task: string): boolean {
    return this.db.prepare("SELECT 1 FROM autonomy_tasks WHERE task = ?").get(task) !== undefined;
  }

  /** Adds the task, with the boss's reason. False when it was autonomous already, or no longer exists. */
  join(task: string, at: string, why?: string): boolean {
    try {
      return (
        this.db
          .prepare("INSERT OR IGNORE INTO autonomy_tasks (task, since, why) VALUES (?, ?, ?)")
          .run(task, at, why ?? null).changes > 0
      );
    } catch {
      // The task was removed meanwhile: its foreign key refuses the row.
      return false;
    }
  }

  tasks(): AutonomyTaskRow[] {
    return (this.db.prepare("SELECT * FROM autonomy_tasks").all() as TaskDbRow[]).map(taskOf);
  }

  task(id: string): AutonomyTaskRow | undefined {
    const row = this.db.prepare("SELECT * FROM autonomy_tasks WHERE task = ?").get(id) as
      | TaskDbRow
      | undefined;
    return row === undefined ? undefined : taskOf(row);
  }

  /** The owner resumed the task by hand: it leaves the held set, and the gate lets it run for now. */
  ownerResumed(task: string, at: string): void {
    this.db
      .prepare("UPDATE autonomy_tasks SET resumed_at = ?, held = NULL, held_scope = NULL WHERE task = ?")
      .run(at, task);
  }

  /** The run gate held the task. A `limit` hold does not replace an `owner` one. */
  hold(task: string, held: HeldReason, scope: string | undefined): void {
    this.db
      .prepare(
        `UPDATE autonomy_tasks SET held = ?, held_scope = ?
         WHERE task = ? AND (held IS NULL OR held = 'limit' OR ? = 'owner')`,
      )
      .run(held, scope ?? null, task, held);
  }

  release(task: string): void {
    this.db.prepare("UPDATE autonomy_tasks SET held = NULL, held_scope = NULL WHERE task = ?").run(task);
  }

  releaseAll(): void {
    this.db.prepare("UPDATE autonomy_tasks SET held = NULL, held_scope = NULL").run();
  }

  // ---------------------------------------------------------------------------
  // The feed

  addEvent(e: NewEvent): number {
    const res = this.db
      .prepare(
        `INSERT INTO autonomy_events (at, kind, text, reason, task, org, agent, command, outcome, unsure, item, status)
         VALUES (@at, @kind, @text, @reason, @task, @org, @agent, @command, @outcome, @unsure, @item, @status)`,
      )
      .run({
        at: e.at,
        kind: e.kind,
        text: e.text,
        reason: e.reason ?? null,
        task: e.task ?? null,
        org: e.org ?? null,
        agent: e.agent ?? null,
        command: e.command ?? null,
        outcome: e.outcome ?? null,
        unsure: e.unsure === true ? 1 : 0,
        item: e.item ?? null,
        status: e.status ?? null,
      });
    return Number(res.lastInsertRowid);
  }

  /** Newest first. */
  events(q: {
    before?: number | undefined;
    limit: number;
    decisions?: boolean;
    task?: string | undefined;
  }): AutonomyEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.before !== undefined) {
      where.push("seq < ?");
      params.push(q.before);
    }
    if (q.decisions === true) where.push(`kind IN (${DECISION_KINDS.map(() => "?").join(", ")})`);
    if (q.decisions === true) params.push(...DECISION_KINDS);
    if (q.task !== undefined) {
      where.push("task = ?");
      params.push(q.task);
    }
    const sql = `SELECT * FROM autonomy_events ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
      ORDER BY seq DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, q.limit) as EventDbRow[]).flatMap(eventOf);
  }

  /** Oldest first, from `from` (inclusive) to `to` (exclusive). */
  eventsBetween(from: string, to: string): AutonomyEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM autonomy_events WHERE at >= ? AND at < ? ORDER BY seq ASC")
        .all(from, to) as EventDbRow[]
    ).flatMap(eventOf);
  }

  /** True when the mode changed from `from` (inclusive) to `to` (exclusive). */
  modeChangedBetween(from: string, to: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM autonomy_events WHERE kind = 'mode' AND at >= ? AND at < ? LIMIT 1")
        .get(from, to) !== undefined
    );
  }

  /** When each inbox or ready task was made, for the backlog's order by age. */
  backlogAges(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT id, created_at FROM tasks WHERE status IN ('inbox', 'ready')")
      .all() as { id: string; created_at: string }[];
    return new Map(rows.map((r) => [r.id, r.created_at]));
  }

  // ---------------------------------------------------------------------------
  // Daily summaries

  /** Stores the day's summary once. False when the day has one already. */
  addSummary(summary: AutonomySummary): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO autonomy_summaries (day, at, summary) VALUES (?, ?, ?)")
        .run(summary.day, summary.at, JSON.stringify(summary)).changes > 0
    );
  }

  hasSummary(day: string): boolean {
    return this.db.prepare("SELECT 1 FROM autonomy_summaries WHERE day = ?").get(day) !== undefined;
  }

  latestSummary(): AutonomySummary | undefined {
    const row = this.db.prepare("SELECT summary FROM autonomy_summaries ORDER BY day DESC LIMIT 1").get() as
      | { summary: string }
      | undefined;
    return row === undefined
      ? undefined
      : parsed<AutonomySummary | undefined>(row.summary, AutonomySummarySchema, undefined);
  }

  // ---------------------------------------------------------------------------
  // Spend

  /**
   * Turns of autonomous tasks since they joined, and of the autonomy chat, from `start` to `end`,
   * summed per org. Tokens count like budgets: input, output and cache writes.
   */
  spendRows(start: string, end: string, chat: string | undefined): OrgSpendRow[] {
    return this.db
      .prepare(
        `SELECT COALESCE(t.org, ?) AS org,
           COALESCE(SUM(t.input_tokens + t.output_tokens + t.cache_write_tokens), 0) AS tokens,
           COALESCE(SUM(t.cost_usd), 0) AS cost
         FROM turns t LEFT JOIN autonomy_tasks a ON a.task = t.task
         WHERE t.at >= ? AND t.at < ? AND ((a.task IS NOT NULL AND t.at >= a.since) OR t.task = ?)
         GROUP BY COALESCE(t.org, ?)`,
      )
      .all(PRIVATE, start, end, chat ?? "", PRIVATE) as OrgSpendRow[];
  }
}

function eventOf(r: EventDbRow): AutonomyEvent[] {
  const out = AutonomyEventSchema.safeParse({
    seq: r.seq,
    at: r.at,
    kind: r.kind,
    text: r.text,
    ...present("reason", r.reason),
    ...present("task", r.task),
    ...present("org", r.org),
    ...present("agent", r.agent),
    ...present("command", r.command),
    ...present("outcome", r.outcome),
    ...(r.unsure === 1 ? { unsure: true } : {}),
    ...present("item", r.item),
    ...present("status", r.status),
  });
  return out.success ? [out.data] : [];
}
