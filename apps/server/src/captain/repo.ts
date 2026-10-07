import {
  type CaptainAction,
  CaptainActionSchema,
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
  decision: string | null;
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

/** What taking a key found: `taken` is the caller's; the others are why it is not. */
export type KeyClaim = "taken" | "repeat" | "in-flight";
export type KeyState = "free" | "repeat" | "in-flight";

/** A claim a crashed call left running is taken over after this long. Longer than the slowest ship (45 minutes). */
export const KEY_IN_FLIGHT_MS = 60 * 60_000;

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
  decision?: string | undefined;
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
    ...(r.decision === null ? {} : { decision: r.decision }),
    outcome: r.outcome,
    ...(undo === undefined ? {} : { undo }),
    ...(undoData?.kind === "rollback" ? { undoWord: "roll-back" } : {}),
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

  /** The start of the chore's last run that did not rest: what a daily schedule counts from. */
  lastWorkedRun(org: string, chore: CaptainChore): string | undefined {
    const row = this.db
      .prepare(
        "SELECT MAX(started_at) AS at FROM captain_runs WHERE org = ? AND chore = ? AND status != 'rested'",
      )
      .get(org, chore) as { at: string | null };
    return row.at ?? undefined;
  }

  /** The runs of one chore in a workspace, newest first. */
  choreRuns(org: string, chore: CaptainChore, limit: number): CaptainRun[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM captain_runs WHERE org = ? AND chore = ? AND status != 'rested' ORDER BY id DESC LIMIT ?",
        )
        .all(org, chore, limit) as RunRow[]
    ).flatMap((r) => runOf(r) ?? []);
  }

  /** How many runs a chore made in a workspace, not counting the ones that rested. */
  runCount(org: string, chore: CaptainChore): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM captain_runs WHERE org = ? AND chore = ? AND status != 'rested'")
        .get(org, chore) as { n: number }
    ).n;
  }

  /** How many log lines the chore made that did something or handed it to the owner. */
  actedCount(org: string, chore: CaptainChore): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM captain_actions WHERE org = ? AND chore = ? AND outcome IN ('done', 'asked')",
        )
        .get(org, chore) as { n: number }
    ).n;
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
  // ---------------------------------------------------------------------------
  // Action keys (G1): one action per state

  /** Whether a key is free, held by a call that is still running, or used: read only. */
  keyState(key: string, now: string): KeyState {
    if (this.hasAction(key)) return "repeat";
    const row = this.db.prepare("SELECT settled, at FROM captain_keys WHERE key = ?").get(key) as
      | { settled: number; at: string }
      | undefined;
    if (row === undefined) return "free";
    if (row.settled === 1) return "repeat";
    return Date.parse(now) - Date.parse(row.at) >= KEY_IN_FLIGHT_MS ? "free" : "in-flight";
  }

  /**
   * Takes a key for one action. The insert on the primary key is the atomic step: of two calls with
   * the same key, one gets "taken" and the other "repeat" (done before) or "in-flight" (still running).
   * A claim a crashed call left unsettled for an hour is taken over.
   */
  claimKey(kind: string, key: string, task: string | undefined, now: string): KeyClaim {
    return this.db.transaction((): KeyClaim => {
      if (this.hasAction(key)) return "repeat";
      const res = this.db
        .prepare("INSERT OR IGNORE INTO captain_keys (key, kind, task, at, settled) VALUES (?, ?, ?, ?, 0)")
        .run(key, kind, task ?? null, now);
      if (res.changes > 0) return "taken";
      const stale = new Date(Date.parse(now) - KEY_IN_FLIGHT_MS).toISOString();
      const took = this.db
        .prepare("UPDATE captain_keys SET at = ?, kind = ? WHERE key = ? AND settled = 0 AND at <= ?")
        .run(now, kind, key, stale);
      if (took.changes > 0) return "taken";
      const row = this.db.prepare("SELECT settled FROM captain_keys WHERE key = ?").get(key) as
        | { settled: number }
        | undefined;
      return row?.settled === 1 ? "repeat" : "in-flight";
    })();
  }

  /** The action ran: the key stays, so the same state is not acted on again, also after a restart. */
  settleKey(key: string): void {
    this.db.prepare("UPDATE captain_keys SET settled = 1 WHERE key = ?").run(key);
  }

  /** The action did not happen, or its log line holds the key now: the claim goes. */
  releaseKey(key: string): void {
    this.db.prepare("DELETE FROM captain_keys WHERE key = ?").run(key);
  }

  /**
   * Counts one captain answer to a task against its progress `mark`. A mark that differs from the one
   * counted before is progress: the count starts again at this answer. Returns whether this answer is
   * the one that reaches `limit` (once per count: later answers on the same mark return false until
   * progress resets it). One transaction, so two answers at once count one each and pause once.
   */
  countAnswer(task: string, mark: string, limit: number): { answers: number; pause: boolean } {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT mark, answers, paused FROM captain_loop_guard WHERE task = ?")
        .get(task) as { mark: string; answers: number; paused: number } | undefined;
      const fresh = row === undefined || row.mark !== mark;
      const answers = fresh ? 1 : row.answers + 1;
      const pause = answers >= limit && (fresh || row.paused === 0);
      this.db
        .prepare(
          `INSERT INTO captain_loop_guard (task, mark, answers, paused) VALUES (?, ?, ?, ?)
           ON CONFLICT(task) DO UPDATE SET mark = excluded.mark, answers = excluded.answers, paused = excluded.paused`,
        )
        .run(task, mark, answers, pause || (!fresh && row.paused === 1) ? 1 : 0);
      return { answers, pause };
    })();
  }

  /** How many actions have a key starting with `prefix`, in any run. */
  countActions(prefix: string): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM captain_actions WHERE substr(key, 1, length(?)) = ?")
      .get(prefix, prefix) as { n: number };
    return row.n;
  }

  /** Adds a line. False when the key is there already: the action was taken before. */
  addAction(a: NewAction): number | undefined {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO captain_actions (key, run, org, chore, day, at, text, reason, evidence, task, decision, outcome, undo, undo_note)
         VALUES (@key, @run, @org, @chore, @day, @at, @text, @reason, @evidence, @task, @decision, @outcome, @undo, @undo_note)`,
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
        decision: a.decision ?? null,
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

  /** Lines made in `[from, to)` (UTC ISO), oldest first: the daily summary's upkeep. */
  actionsBetween(from: string, to: string): StoredAction[] {
    return (
      this.db
        .prepare("SELECT * FROM captain_actions WHERE at >= ? AND at < ? ORDER BY id")
        .all(from, to) as ActionRow[]
    ).flatMap((r) => actionOf(r) ?? []);
  }

  /** The log lines one run made, oldest first. */
  actionsOfRun(run: number): StoredAction[] {
    return (
      this.db.prepare("SELECT * FROM captain_actions WHERE run = ? ORDER BY id").all(run) as ActionRow[]
    ).flatMap((r) => actionOf(r) ?? []);
  }

  /** A chore's runs, what it did and what the owner undid since `since` (UTC ISO). Rested runs do not count. */
  weekOf(
    org: string,
    chore: CaptainChore,
    since: string,
  ): { runs: number; results: number; undone: number; tokens: number } {
    const runs = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(tokens), 0) AS t FROM captain_runs WHERE org = ? AND chore = ? AND status != 'rested' AND started_at >= ?",
      )
      .get(org, chore, since) as { n: number; t: number };
    const acts = this.db
      .prepare(
        `SELECT COALESCE(SUM(outcome IN ('done', 'asked')), 0) AS results, COALESCE(SUM(undone_at IS NOT NULL), 0) AS undone
         FROM captain_actions WHERE org = ? AND chore = ? AND at >= ?`,
      )
      .get(org, chore, since) as { results: number; undone: number };
    return { runs: runs.n, results: acts.results, undone: acts.undone, tokens: runs.t };
  }

  action(id: number): StoredAction | undefined {
    const row = this.db.prepare("SELECT * FROM captain_actions WHERE id = ?").get(id) as
      | ActionRow
      | undefined;
    return row === undefined ? undefined : actionOf(row);
  }

  actions(q: {
    org?: string | undefined;
    before?: number | undefined;
    after?: number | undefined;
    limit: number;
  }): StoredAction[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.after !== undefined) {
      where.push("id > ?");
      params.push(q.after);
    }
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
