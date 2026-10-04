import {
  type PlaybookRun,
  PlaybookRunSchema,
  type PlaybookRunStatus,
  type PlaybookState,
  PlaybookStateSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";

/** The playbook tables in `majhi.db` (migration 132): what the owner changed, and the run history. */

interface StateRow {
  state: string;
  failures: number;
  backoff_until: string | null;
  last_run: string | null;
}

interface RunRow {
  id: number;
  org: string;
  playbook: string;
  trigger: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  note: string | null;
  findings: number;
  tokens: number;
  chat: string | null;
}

function toRun(r: RunRow): PlaybookRun {
  return PlaybookRunSchema.parse({
    id: r.id,
    org: r.org,
    playbook: r.playbook,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.started_at,
    ...(r.ended_at === null ? {} : { endedAt: r.ended_at }),
    ...(r.note === null ? {} : { note: r.note }),
    findings: r.findings,
    tokens: r.tokens,
  });
}

export interface StoredState {
  state: PlaybookState;
  failures: number;
  backoffUntil?: string;
  lastRun?: string;
}

export class PlaybookRepo {
  constructor(private readonly db: Database.Database) {}

  state(org: string, playbook: string): StoredState {
    const row = this.db
      .prepare(
        "SELECT state, failures, backoff_until, last_run FROM playbook_state WHERE org = ? AND playbook = ?",
      )
      .get(org, playbook) as StateRow | undefined;
    if (row === undefined) return { state: {}, failures: 0 };
    let parsed: PlaybookState = {};
    try {
      const p = PlaybookStateSchema.safeParse(JSON.parse(row.state));
      if (p.success) parsed = p.data;
    } catch {
      // A damaged row reads as the defaults.
    }
    return {
      state: parsed,
      failures: row.failures,
      ...(row.backoff_until === null ? {} : { backoffUntil: row.backoff_until }),
      ...(row.last_run === null ? {} : { lastRun: row.last_run }),
    };
  }

  private ensure(org: string, playbook: string): void {
    this.db.prepare("INSERT OR IGNORE INTO playbook_state (org, playbook) VALUES (?, ?)").run(org, playbook);
  }

  setState(org: string, playbook: string, state: PlaybookState): void {
    this.ensure(org, playbook);
    this.db
      .prepare("UPDATE playbook_state SET state = ? WHERE org = ? AND playbook = ?")
      .run(JSON.stringify(state), org, playbook);
  }

  /** A run started: the last-run time moves, so the next sweep does not start it again. */
  touch(org: string, playbook: string, at: string): void {
    this.ensure(org, playbook);
    this.db
      .prepare("UPDATE playbook_state SET last_run = ? WHERE org = ? AND playbook = ?")
      .run(at, org, playbook);
  }

  /** A failed run: the count rises and the next try waits (backoff doubles from 15 minutes up to 6 hours). */
  failed(org: string, playbook: string, until: string): number {
    this.ensure(org, playbook);
    this.db
      .prepare(
        "UPDATE playbook_state SET failures = failures + 1, backoff_until = ? WHERE org = ? AND playbook = ?",
      )
      .run(until, org, playbook);
    return this.state(org, playbook).failures;
  }

  succeeded(org: string, playbook: string): void {
    this.db
      .prepare("UPDATE playbook_state SET failures = 0, backoff_until = NULL WHERE org = ? AND playbook = ?")
      .run(org, playbook);
  }

  /** Opens a run. Undefined when one is open for this playbook and workspace already (single flight). */
  openRun(n: {
    org: string;
    playbook: string;
    trigger: string;
    at: string;
    chat?: string | undefined;
  }): number | undefined {
    try {
      const info = this.db
        .prepare(
          "INSERT INTO playbook_runs (org, playbook, trigger, status, started_at, chat) VALUES (?, ?, ?, 'running', ?, ?)",
        )
        .run(n.org, n.playbook, n.trigger, n.at, n.chat ?? null);
      return Number(info.lastInsertRowid);
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) return undefined;
      throw err;
    }
  }

  openFor(org: string, playbook: string): PlaybookRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM playbook_runs WHERE org = ? AND playbook = ? AND status = 'running'")
      .get(org, playbook) as RunRow | undefined;
    return row === undefined ? undefined : toRun(row);
  }

  run(id: number): (PlaybookRun & { chat?: string }) | undefined {
    const row = this.db.prepare("SELECT * FROM playbook_runs WHERE id = ?").get(id) as RunRow | undefined;
    if (row === undefined) return undefined;
    return { ...toRun(row), ...(row.chat === null ? {} : { chat: row.chat }) };
  }

  /** Ends a run that is still open. False when it was ended already. */
  closeRun(
    id: number,
    status: Exclude<PlaybookRunStatus, "running">,
    at: string,
    note: string | undefined,
    extra: { findings?: number; tokens?: number } = {},
  ): boolean {
    const done = this.db
      .prepare(
        `UPDATE playbook_runs SET status = ?, ended_at = ?, note = ?,
           findings = COALESCE(?, findings), tokens = COALESCE(?, tokens)
         WHERE id = ? AND status = 'running'`,
      )
      .run(status, at, note ?? null, extra.findings ?? null, extra.tokens ?? null, id);
    return done.changes > 0;
  }

  /** Runs a restart cut short end as stopped. */
  closeOpenRuns(at: string, why: string): number {
    return this.db
      .prepare("UPDATE playbook_runs SET status = 'stopped', ended_at = ?, note = ? WHERE status = 'running'")
      .run(at, why).changes;
  }

  openRuns(): (PlaybookRun & { chat?: string })[] {
    return (this.db.prepare("SELECT * FROM playbook_runs WHERE status = 'running'").all() as RunRow[]).map(
      (r) => ({ ...toRun(r), ...(r.chat === null ? {} : { chat: r.chat }) }),
    );
  }

  runs(org: string, playbook: string, limit: number): PlaybookRun[] {
    return (
      this.db
        .prepare("SELECT * FROM playbook_runs WHERE org = ? AND playbook = ? ORDER BY id DESC LIMIT ?")
        .all(org, playbook, limit) as RunRow[]
    ).map(toRun);
  }

  lastRun(org: string, playbook: string): { startedAt: string; note?: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT started_at, note FROM playbook_runs WHERE org = ? AND playbook = ? ORDER BY id DESC LIMIT 1",
      )
      .get(org, playbook) as { started_at: string; note: string | null } | undefined;
    if (row === undefined) return undefined;
    return { startedAt: row.started_at, ...(row.note === null ? {} : { note: row.note }) };
  }

  /** Runs that finished (not nothing) plus quiet ones: how often it ran. */
  ranCount(org: string, playbook: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM playbook_runs WHERE org = ? AND playbook = ?")
        .get(org, playbook) as { n: number }
    ).n;
  }

  addFindings(id: number, n: number): void {
    this.db.prepare("UPDATE playbook_runs SET findings = findings + ? WHERE id = ?").run(n, id);
  }
}
