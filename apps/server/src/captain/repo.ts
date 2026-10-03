import {
  type CaptainAction,
  CaptainActionSchema,
  type CaptainCapAsk,
  CaptainCapAskSchema,
  type CaptainChore,
  type CaptainRun,
  CaptainRunSchema,
  type CaptainRunStatus,
  type CaptainUndo,
  CaptainUndoSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";

/** The captain's tables in `majhi.db` (migration 116). */

interface ActionRow {
  id: number;
  key: string;
  run: number | null;
  org: string;
  chore: string;
  day: string;
  at: string;
  text: string;
  reason: string;
  evidence: string | null;
  task: string | null;
  outcome: string;
  undo: string | null;
  undo_note: string | null;
  undone_at: string | null;
}

interface RunRow {
  id: number;
  org: string;
  chore: string;
  day: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  trigger: string;
  actions: number;
  tokens: number;
  note: string | null;
}

export interface NewAction {
  key: string;
  run?: number | undefined;
  org: string;
  chore: CaptainChore;
  day: string;
  at: string;
  text: string;
  reason: string;
  evidence?: string | undefined;
  task?: string | undefined;
  outcome: CaptainAction["outcome"];
  undo?: CaptainUndo | undefined;
  /** Why Undo is not possible, when it is not. */
  undoNote?: string | undefined;
}

export interface StoredAction extends CaptainAction {
  key: string;
  run?: number;
  undoData?: CaptainUndo;
}

function actionOf(r: ActionRow): StoredAction | undefined {
  let undoData: CaptainUndo | undefined;
  if (r.undo !== null) {
    try {
      const parsed = CaptainUndoSchema.safeParse(JSON.parse(r.undo));
      if (parsed.success) undoData = parsed.data;
    } catch {
      undoData = undefined;
    }
  }
  const undo =
    r.undone_at !== null ? "done" : undoData !== undefined ? "yes" : r.undo_note !== null ? "no" : undefined;
  const out = CaptainActionSchema.safeParse({
    id: r.id,
    at: r.at,
    org: r.org,
    chore: r.chore,
    text: r.text,
    reason: r.reason,
    ...(r.evidence === null ? {} : { evidence: r.evidence }),
    ...(r.task === null ? {} : { task: r.task }),
    outcome: r.outcome,
    ...(undo === undefined ? {} : { undo }),
    ...(r.undo_note === null ? {} : { undoNote: r.undo_note }),
    ...(r.undone_at === null ? {} : { undoneAt: r.undone_at }),
  });
  if (!out.success) return undefined;
  return {
    ...out.data,
    key: r.key,
    ...(r.run === null ? {} : { run: r.run }),
    ...(undoData === undefined ? {} : { undoData }),
  };
}

function runOf(r: RunRow): CaptainRun | undefined {
  const out = CaptainRunSchema.safeParse({
    id: r.id,
    org: r.org,
    chore: r.chore,
    startedAt: r.started_at,
    ...(r.ended_at === null ? {} : { endedAt: r.ended_at }),
    status: r.status,
    trigger: r.trigger,
    actions: r.actions,
    tokens: r.tokens,
    ...(r.note === null ? {} : { note: r.note }),
  });
  return out.success ? out.data : undefined;
}

export class CaptainRepo {
  constructor(private readonly db: Database.Database) {}

  // ---------------------------------------------------------------------------
  // The stop switch

  state(): { stopped: boolean; stoppedAt?: string; summaryDay?: string } {
    const row = this.db
      .prepare("SELECT stopped, stopped_at, summary_day FROM captain_state WHERE id = 1")
      .get() as { stopped: number; stopped_at: string | null; summary_day: string | null } | undefined;
    if (row === undefined) return { stopped: false };
    return {
      stopped: row.stopped === 1,
      ...(row.stopped_at === null ? {} : { stoppedAt: row.stopped_at }),
      ...(row.summary_day === null ? {} : { summaryDay: row.summary_day }),
    };
  }

  setStopped(stopped: boolean, at: string): void {
    this.db
      .prepare("UPDATE captain_state SET stopped = ?, stopped_at = ? WHERE id = 1")
      .run(stopped ? 1 : 0, stopped ? at : null);
  }

  /** The day the owner was last told the summaries. False when that day was told already. */
  markSummary(day: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE captain_state SET summary_day = ? WHERE id = 1 AND (summary_day IS NULL OR summary_day < ?)",
        )
        .run(day, day).changes > 0
    );
  }

  // ---------------------------------------------------------------------------
  // Lanes

  lanes(): { org: string; chat: string }[] {
    return this.db.prepare("SELECT org, chat FROM captain_lanes ORDER BY org").all() as {
      org: string;
      chat: string;
    }[];
  }

  lane(org: string): string | undefined {
    const row = this.db.prepare("SELECT chat FROM captain_lanes WHERE org = ?").get(org) as
      | { chat: string }
      | undefined;
    return row?.chat;
  }

  laneOrg(chat: string): string | undefined {
    const row = this.db.prepare("SELECT org FROM captain_lanes WHERE chat = ?").get(chat) as
      | { org: string }
      | undefined;
    return row?.org;
  }

  setLane(org: string, chat: string, at: string): void {
    this.db
      .prepare(
        "INSERT INTO captain_lanes (org, chat, created_at) VALUES (?, ?, ?) ON CONFLICT (org) DO UPDATE SET chat = excluded.chat, created_at = excluded.created_at",
      )
      .run(org, chat, at);
  }

  // ---------------------------------------------------------------------------
  // Runs

  /** Opens a run. Undefined when one is open for this chore and workspace already. */
  openRun(r: {
    org: string;
    chore: CaptainChore;
    day: string;
    at: string;
    trigger: string;
  }): number | undefined {
    try {
      const res = this.db
        .prepare(
          "INSERT INTO captain_runs (org, chore, day, started_at, status, trigger) VALUES (?, ?, ?, ?, 'running', ?)",
        )
        .run(r.org, r.chore, r.day, r.at, r.trigger);
      return Number(res.lastInsertRowid);
    } catch {
      // The partial unique index: a run of this chore is open in this workspace.
      return undefined;
    }
  }

  closeRun(id: number, status: Exclude<CaptainRunStatus, "running">, at: string, note?: string): void {
    this.db
      .prepare(
        "UPDATE captain_runs SET status = ?, ended_at = ?, note = COALESCE(?, note) WHERE id = ? AND ended_at IS NULL",
      )
      .run(status, at, note ?? null, id);
  }

  countRunAction(id: number): void {
    this.db.prepare("UPDATE captain_runs SET actions = actions + 1 WHERE id = ?").run(id);
  }

  setRunTokens(id: number, tokens: number): void {
    this.db.prepare("UPDATE captain_runs SET tokens = ? WHERE id = ?").run(tokens, id);
  }

  run(id: number): CaptainRun | undefined {
    const row = this.db.prepare("SELECT * FROM captain_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row === undefined ? undefined : runOf(row);
  }

  /** Runs a restart left open: they end as stopped. */
  closeOpenRuns(at: string, note: string): number {
    return this.db
      .prepare("UPDATE captain_runs SET status = 'stopped', ended_at = ?, note = ? WHERE ended_at IS NULL")
      .run(at, note).changes;
  }

  runsToday(org: string, chore: CaptainChore, day: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM captain_runs WHERE org = ? AND chore = ? AND day = ? AND status != 'rested'",
      )
      .get(org, chore, day) as { n: number };
    return row.n;
  }

  lastRun(org: string, chore: CaptainChore): string | undefined {
    const row = this.db
      .prepare("SELECT MAX(started_at) AS at FROM captain_runs WHERE org = ? AND chore = ?")
      .get(org, chore) as { at: string | null };
    return row.at ?? undefined;
  }

  runs(q: { org?: string | undefined; limit: number }): CaptainRun[] {
    const rows = (
      q.org === undefined
        ? this.db.prepare("SELECT * FROM captain_runs ORDER BY id DESC LIMIT ?").all(q.limit)
        : this.db
            .prepare("SELECT * FROM captain_runs WHERE org = ? ORDER BY id DESC LIMIT ?")
            .all(q.org, q.limit)
    ) as RunRow[];
    return rows.flatMap((r) => runOf(r) ?? []);
  }

  allRuns(): CaptainRun[] {
    return (this.db.prepare("SELECT * FROM captain_runs ORDER BY id").all() as RunRow[]).flatMap(
      (r) => runOf(r) ?? [],
    );
  }

  // ---------------------------------------------------------------------------
  // The log

  hasAction(key: string): boolean {
    return this.db.prepare("SELECT 1 FROM captain_actions WHERE key = ?").get(key) !== undefined;
  }

  /** Adds a line. False when the key is there already: the action was taken before. */
  addAction(a: NewAction): number | undefined {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO captain_actions (key, run, org, chore, day, at, text, reason, evidence, task, outcome, undo, undo_note)
         VALUES (@key, @run, @org, @chore, @day, @at, @text, @reason, @evidence, @task, @outcome, @undo, @undo_note)`,
      )
      .run({
        key: a.key,
        run: a.run ?? null,
        org: a.org,
        chore: a.chore,
        day: a.day,
        at: a.at,
        text: a.text,
        reason: a.reason,
        evidence: a.evidence ?? null,
        task: a.task ?? null,
        outcome: a.outcome,
        undo: a.undo === undefined ? null : JSON.stringify(a.undo),
        undo_note: a.undoNote ?? null,
      });
    return res.changes > 0 ? Number(res.lastInsertRowid) : undefined;
  }

  /** Done and handed-over lines of a chore today: what its daily cap counts. */
  actionsToday(org: string, chore: CaptainChore, day: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM captain_actions WHERE org = ? AND chore = ? AND day = ? AND outcome IN ('done', 'asked')",
      )
      .get(org, chore, day) as { n: number };
    return row.n;
  }

  /** A workspace's lines of a day, oldest first. */
  dayActions(org: string, day: string): StoredAction[] {
    return (
      this.db
        .prepare("SELECT * FROM captain_actions WHERE org = ? AND day = ? ORDER BY id")
        .all(org, day) as ActionRow[]
    ).flatMap((r) => actionOf(r) ?? []);
  }

  action(id: number): StoredAction | undefined {
    const row = this.db.prepare("SELECT * FROM captain_actions WHERE id = ?").get(id) as
      | ActionRow
      | undefined;
    return row === undefined ? undefined : actionOf(row);
  }

  actions(q: { org?: string | undefined; before?: number | undefined; limit: number }): StoredAction[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.org !== undefined) {
      where.push("org = ?");
      params.push(q.org);
    }
    if (q.before !== undefined) {
      where.push("id < ?");
      params.push(q.before);
    }
    const sql = `SELECT * FROM captain_actions ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, q.limit) as ActionRow[]).flatMap((r) => actionOf(r) ?? []);
  }

  allActions(): StoredAction[] {
    return (this.db.prepare("SELECT * FROM captain_actions ORDER BY id").all() as ActionRow[]).flatMap(
      (r) => actionOf(r) ?? [],
    );
  }

  markUndone(id: number, at: string): boolean {
    return (
      this.db
        .prepare("UPDATE captain_actions SET undone_at = ? WHERE id = ? AND undone_at IS NULL")
        .run(at, id).changes > 0
    );
  }

  // ---------------------------------------------------------------------------
  // The circuit breaker

  chore(org: string, chore: CaptainChore): { failures: number; offAt?: string; offWhy?: string } {
    const row = this.db
      .prepare("SELECT failures, off_at, off_why FROM captain_chores WHERE org = ? AND chore = ?")
      .get(org, chore) as { failures: number; off_at: string | null; off_why: string | null } | undefined;
    if (row === undefined) return { failures: 0 };
    return {
      failures: row.failures,
      ...(row.off_at === null ? {} : { offAt: row.off_at }),
      ...(row.off_why === null ? {} : { offWhy: row.off_why }),
    };
  }

  /** One more failure in a row; returns how many now. */
  failed(org: string, chore: CaptainChore): number {
    this.db
      .prepare(
        "INSERT INTO captain_chores (org, chore, failures) VALUES (?, ?, 1) ON CONFLICT (org, chore) DO UPDATE SET failures = failures + 1",
      )
      .run(org, chore);
    return this.chore(org, chore).failures;
  }

  succeeded(org: string, chore: CaptainChore): void {
    this.db.prepare("UPDATE captain_chores SET failures = 0 WHERE org = ? AND chore = ?").run(org, chore);
  }

  turnOff(org: string, chore: CaptainChore, at: string, why: string): void {
    this.db
      .prepare(
        "INSERT INTO captain_chores (org, chore, failures, off_at, off_why) VALUES (?, ?, 0, ?, ?) ON CONFLICT (org, chore) DO UPDATE SET off_at = excluded.off_at, off_why = excluded.off_why",
      )
      .run(org, chore, at, why);
  }

  turnOn(org: string, chore: CaptainChore): void {
    this.db
      .prepare(
        "UPDATE captain_chores SET failures = 0, off_at = NULL, off_why = NULL WHERE org = ? AND chore = ?",
      )
      .run(org, chore);
  }

  // ---------------------------------------------------------------------------
  // Daily caps the owner is asked about

  /** Records the question; false when one was asked about this chore, workspace and day already. */
  addCapAsk(ask: CaptainCapAsk): boolean {
    const done = this.db
      .prepare(
        "INSERT OR IGNORE INTO captain_cap_asks (org, chore, day, kind, cap, raise_to, text, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(ask.org, ask.chore, ask.day, ask.kind, ask.cap, ask.raiseTo, ask.text, ask.at);
    return done.changes > 0;
  }

  /** The owner raised the chore's caps in the workspace for that day. */
  capRaised(org: string, chore: CaptainChore, day: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS yes FROM captain_cap_asks WHERE org = ? AND chore = ? AND day = ? AND state = 'raised'",
      )
      .get(org, chore, day);
    return row !== undefined;
  }

  /** Questions still waiting for the owner, oldest first. */
  pendingCapAsks(): CaptainCapAsk[] {
    const rows = this.db
      .prepare(
        "SELECT org, chore, day, kind, cap, raise_to, text, at FROM captain_cap_asks WHERE state = 'pending' ORDER BY at",
      )
      .all() as {
      org: string;
      chore: string;
      day: string;
      kind: string;
      cap: number;
      raise_to: number;
      text: string;
      at: string;
    }[];
    return rows.flatMap((r) => {
      const ask = CaptainCapAskSchema.safeParse({ ...r, raiseTo: r.raise_to });
      return ask.success ? [ask.data] : [];
    });
  }

  /** The owner's answer to the day's question. False when there was none waiting. */
  answerCapAsk(org: string, chore: CaptainChore, day: string, state: "raised" | "left", at: string): boolean {
    const done = this.db
      .prepare(
        "UPDATE captain_cap_asks SET state = ?, answered_at = ? WHERE org = ? AND chore = ? AND day = ? AND state = 'pending'",
      )
      .run(state, at, org, chore, day);
    return done.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Spend

  /** Tokens and dollars the lane spent from `from` (inclusive). */
  laneSpend(chat: string, from: string): { tokens: number; cost: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_write_tokens), 0) AS tokens,
           COALESCE(SUM(cost_usd), 0) AS cost FROM turns WHERE task = ? AND at >= ?`,
      )
      .get(chat, from) as { tokens: number; cost: number };
    return row;
  }
}
