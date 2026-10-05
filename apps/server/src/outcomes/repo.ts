import { DEFAULT_MINUTES, type OutcomeKind, type OutcomeResult, OutcomeResultSchema } from "@majhi/shared";
import type Database from "better-sqlite3";

/** The tables of migration 134: outcomes, the trust ladder's state and notices, minutes, money. */

export interface OutcomeRow {
  id: number;
  subject: string;
  kind: OutcomeKind;
  org: string;
  key: string | undefined;
  playbook: string | undefined;
  action: number | undefined;
  task: string | undefined;
  at: string;
  result: OutcomeResult | undefined;
  settledAt: string | undefined;
}

interface Raw {
  id: number;
  subject: string;
  kind: string;
  org: string;
  key: string | null;
  playbook: string | null;
  action: number | null;
  task: string | null;
  at: string;
  result: string | null;
  settled_at: string | null;
}

function rowOf(r: Raw): OutcomeRow {
  const parsed = OutcomeResultSchema.safeParse(r.result);
  return {
    id: r.id,
    subject: r.subject,
    kind: r.kind as OutcomeKind,
    org: r.org,
    key: r.key ?? undefined,
    playbook: r.playbook ?? undefined,
    action: r.action ?? undefined,
    task: r.task ?? undefined,
    at: r.at,
    result: parsed.success ? parsed.data : undefined,
    settledAt: r.settled_at ?? undefined,
  };
}

/** An output as the derivation sees it. `result` is its judgment now, or empty. */
export interface Derived {
  subject: string;
  kind: OutcomeKind;
  org: string;
  key?: string | undefined;
  playbook?: string | undefined;
  action?: number | undefined;
  task?: string | undefined;
  at: string;
  result?: OutcomeResult | undefined;
  /** When it was judged, for the result it has. */
  settledAt?: string | undefined;
}

export interface TrustNotice {
  id: number;
  org: string;
  key: string;
  kind: "demoted" | "promote" | "muted";
  text: string;
  evidence: string;
  state: "open" | "accepted" | "dismissed" | "undone" | "snoozed";
  data: Record<string, unknown>;
  at: string;
  answeredAt: string | undefined;
}

interface NoticeRaw {
  id: number;
  org: string;
  key: string;
  kind: string;
  text: string;
  evidence: string;
  state: string;
  data: string;
  at: string;
  answered_at: string | null;
}

function noticeOf(r: NoticeRaw): TrustNotice {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(r.data);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return {
    id: r.id,
    org: r.org,
    key: r.key,
    kind: r.kind as TrustNotice["kind"],
    text: r.text,
    evidence: r.evidence,
    state: r.state as TrustNotice["state"],
    data,
    at: r.at,
    answeredAt: r.answered_at ?? undefined,
  };
}

export class OutcomesRepo {
  constructor(private readonly db: Database.Database) {}

  // ---------------------------------------------------------------------------
  // Outcomes

  /** Writes what the derivation found: a new subject is added, a known one changes only its judgment. */
  upsert(d: Derived, now: string): void {
    const result = d.result ?? null;
    this.db
      .prepare(
        `INSERT INTO outcomes (subject, kind, org, key, playbook, action, task, at, result, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subject) DO UPDATE SET
           result = excluded.result,
           settled_at = CASE WHEN excluded.result IS outcomes.result THEN outcomes.settled_at ELSE excluded.settled_at END,
           key = COALESCE(excluded.key, outcomes.key),
           playbook = COALESCE(excluded.playbook, outcomes.playbook)`,
      )
      .run(
        d.subject,
        d.kind,
        d.org,
        d.key ?? null,
        d.playbook ?? null,
        d.action ?? null,
        d.task ?? null,
        d.at,
        result,
        result === null ? null : (d.settledAt ?? now),
      );
  }

  /**
   * Writes what the derivation found, but only the rows that are new or whose judgment, key or playbook
   * differ from the stored row: `upsert` of 5,000 unchanged rows every pass cost 250 ms for nothing.
   * Returns how many rows were written.
   */
  upsertChanged(derived: readonly Derived[], now: string): number {
    const stored = new Map<string, { result: string | null; key: string | null; playbook: string | null }>();
    for (const r of this.db.prepare("SELECT subject, result, key, playbook FROM outcomes").all() as {
      subject: string;
      result: string | null;
      key: string | null;
      playbook: string | null;
    }[])
      stored.set(r.subject, r);
    const changed = derived.filter((d) => {
      const row = stored.get(d.subject);
      if (row === undefined) return true;
      return (
        (d.result ?? null) !== row.result ||
        (d.key !== undefined && d.key !== row.key) ||
        (d.playbook !== undefined && d.playbook !== row.playbook)
      );
    });
    if (changed.length === 0) return 0;
    this.db.transaction(() => {
      for (const d of changed) this.upsert(d, now);
    })();
    return changed.length;
  }

  /** Writes a judgment the owner made once and nothing else will recompute (an answer against a recommendation). */
  record(d: Derived, now: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO outcomes (subject, kind, org, key, playbook, action, task, at, result, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.subject,
        d.kind,
        d.org,
        d.key ?? null,
        d.playbook ?? null,
        d.action ?? null,
        d.task ?? null,
        d.at,
        d.result ?? null,
        d.settledAt ?? now,
      );
  }

  get(subject: string): OutcomeRow | undefined {
    const row = this.db.prepare("SELECT * FROM outcomes WHERE subject = ?").get(subject) as Raw | undefined;
    return row === undefined ? undefined : rowOf(row);
  }

  /** Outputs made in a span, optionally of one workspace. */
  between(from: string, to: string, org?: string): OutcomeRow[] {
    const rows =
      org === undefined
        ? this.db.prepare("SELECT * FROM outcomes WHERE at >= ? AND at < ? ORDER BY at").all(from, to)
        : this.db
            .prepare("SELECT * FROM outcomes WHERE at >= ? AND at < ? AND org = ? ORDER BY at")
            .all(from, to, org);
    return (rows as Raw[]).map(rowOf);
  }

  /** The newest judged outputs of an authority row or channel, newest first, after `since`. */
  judgedForKey(org: string, key: string, since: string | undefined, limit: number): OutcomeRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM outcomes WHERE org = ? AND key = ? AND result IS NOT NULL AND result != 'void'
             AND at > ? ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(org, key, since ?? "", limit) as Raw[]
    ).map(rowOf);
  }

  /** The newest judged findings of a playbook, newest first, after `since`. */
  judgedFindings(org: string, playbook: string, since: string | undefined, limit: number): OutcomeRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM outcomes WHERE org = ? AND playbook = ? AND kind = 'finding' AND result IS NOT NULL
             AND result != 'void' AND at > ? ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(org, playbook, since ?? "", limit) as Raw[]
    ).map(rowOf);
  }

  /** Authority rows and channels that have outputs, per workspace. */
  keys(): { org: string; key: string }[] {
    return this.db.prepare("SELECT DISTINCT org, key FROM outcomes WHERE key IS NOT NULL").all() as {
      org: string;
      key: string;
    }[];
  }

  playbooks(): { org: string; playbook: string }[] {
    return this.db
      .prepare("SELECT DISTINCT org, playbook FROM outcomes WHERE playbook IS NOT NULL AND kind = 'finding'")
      .all() as { org: string; playbook: string }[];
  }

  /** Whether a bad outcome of the owner's, taking something back, was judged since a time. */
  overruledSince(org: string, key: string, since: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM outcomes WHERE org = ? AND key = ? AND settled_at >= ?
             AND result IN ('undone', 'reverted', 'merged-reverted', 'rejected', 'overruled') LIMIT 1`,
        )
        .get(org, key, since) !== undefined
    );
  }

  // ---------------------------------------------------------------------------
  // The ladder

  trust(org: string, key: string): { since?: string; snoozedUntil?: string; autoOk: boolean } {
    const row = this.db
      .prepare("SELECT since, snoozed_until, auto_ok FROM trust_state WHERE org = ? AND key = ?")
      .get(org, key) as { since: string | null; snoozed_until: string | null; auto_ok: number } | undefined;
    if (row === undefined) return { autoOk: false };
    return {
      ...(row.since === null ? {} : { since: row.since }),
      ...(row.snoozed_until === null ? {} : { snoozedUntil: row.snoozed_until }),
      autoOk: row.auto_ok === 1,
    };
  }

  setTrust(
    org: string,
    key: string,
    change: {
      since?: string | undefined;
      snoozedUntil?: string | null | undefined;
      autoOk?: boolean | undefined;
    },
  ): void {
    const had = this.trust(org, key);
    const since = change.since ?? had.since ?? null;
    const snoozed = change.snoozedUntil === undefined ? (had.snoozedUntil ?? null) : change.snoozedUntil;
    const autoOk = change.autoOk ?? had.autoOk;
    this.db
      .prepare(
        `INSERT INTO trust_state (org, key, since, snoozed_until, auto_ok) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org, key) DO UPDATE SET since = excluded.since, snoozed_until = excluded.snoozed_until,
           auto_ok = excluded.auto_ok`,
      )
      .run(org, key, since, snoozed, autoOk ? 1 : 0);
  }

  /** Adds a notice. Undefined when the same one is open already. */
  addNotice(n: Omit<TrustNotice, "id" | "state" | "answeredAt">): TrustNotice | undefined {
    try {
      const info = this.db
        .prepare(
          "INSERT INTO trust_notices (org, key, kind, text, evidence, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(n.org, n.key, n.kind, n.text, n.evidence, JSON.stringify(n.data), n.at);
      return this.notice(Number(info.lastInsertRowid));
    } catch {
      return undefined;
    }
  }

  notice(id: number): TrustNotice | undefined {
    const row = this.db.prepare("SELECT * FROM trust_notices WHERE id = ?").get(id) as NoticeRaw | undefined;
    return row === undefined ? undefined : noticeOf(row);
  }

  openNotices(): TrustNotice[] {
    return (
      this.db.prepare("SELECT * FROM trust_notices WHERE state = 'open' ORDER BY id").all() as NoticeRaw[]
    ).map(noticeOf);
  }

  /** The newest notice of a kind for a row, whatever its state. */
  lastNotice(org: string, key: string, kind: TrustNotice["kind"]): TrustNotice | undefined {
    const row = this.db
      .prepare("SELECT * FROM trust_notices WHERE org = ? AND key = ? AND kind = ? ORDER BY id DESC LIMIT 1")
      .get(org, key, kind) as NoticeRaw | undefined;
    return row === undefined ? undefined : noticeOf(row);
  }

  /** The playbooks muted and not yet undone. */
  mutedNotices(org?: string): TrustNotice[] {
    const base = "SELECT * FROM trust_notices WHERE kind = 'muted' AND state IN ('open', 'accepted')";
    const rows =
      org === undefined
        ? (this.db.prepare(`${base} ORDER BY id`).all() as NoticeRaw[])
        : (this.db.prepare(`${base} AND org = ? ORDER BY id`).all(org) as NoticeRaw[]);
    return rows.map(noticeOf);
  }

  closeNotice(id: number, state: TrustNotice["state"], now: string, data?: Record<string, unknown>): void {
    this.db
      .prepare("UPDATE trust_notices SET state = ?, answered_at = ?, data = COALESCE(?, data) WHERE id = ?")
      .run(state, now, data === undefined ? null : JSON.stringify(data), id);
  }

  // ---------------------------------------------------------------------------
  // Minutes, money

  minutes(): Record<string, number> {
    const out: Record<string, number> = { ...DEFAULT_MINUTES };
    for (const r of this.db.prepare("SELECT kind, minutes FROM scorecard_minutes").all() as {
      kind: string;
      minutes: number;
    }[]) {
      out[r.kind] = r.minutes;
    }
    return out;
  }

  setMinutes(kind: string, minutes: number | undefined): void {
    if (minutes === undefined) {
      this.db.prepare("DELETE FROM scorecard_minutes WHERE kind = ?").run(kind);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO scorecard_minutes (kind, minutes) VALUES (?, ?) ON CONFLICT (kind) DO UPDATE SET minutes = excluded.minutes",
      )
      .run(kind, minutes);
  }

  moneyValue(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM money_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMoneyValue(key: string, value: string | undefined): void {
    if (value === undefined) {
      this.db.prepare("DELETE FROM money_state WHERE key = ?").run(key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO money_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  rates(): Map<string, { retainerUsd?: number; hourlyUsd?: number }> {
    const out = new Map<string, { retainerUsd?: number; hourlyUsd?: number }>();
    for (const r of this.db.prepare("SELECT org, retainer_usd, hourly_usd FROM org_rates").all() as {
      org: string;
      retainer_usd: number | null;
      hourly_usd: number | null;
    }[]) {
      out.set(r.org, {
        ...(r.retainer_usd === null ? {} : { retainerUsd: r.retainer_usd }),
        ...(r.hourly_usd === null ? {} : { hourlyUsd: r.hourly_usd }),
      });
    }
    return out;
  }

  setRates(
    org: string,
    change: { retainerUsd?: number | null | undefined; hourlyUsd?: number | null | undefined },
  ): void {
    const had = this.rates().get(org) ?? {};
    const retainer = change.retainerUsd === undefined ? (had.retainerUsd ?? null) : change.retainerUsd;
    const hourly = change.hourlyUsd === undefined ? (had.hourlyUsd ?? null) : change.hourlyUsd;
    if (retainer === null && hourly === null) {
      this.db.prepare("DELETE FROM org_rates WHERE org = ?").run(org);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO org_rates (org, retainer_usd, hourly_usd) VALUES (?, ?, ?)
         ON CONFLICT (org) DO UPDATE SET retainer_usd = excluded.retainer_usd, hourly_usd = excluded.hourly_usd`,
      )
      .run(org, retainer, hourly);
  }
}
