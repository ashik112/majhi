import {
  type OpsCheckKind,
  type OpsIncident,
  OpsIncidentSchema,
  type OpsSample,
  type OpsServiceDef,
  OpsServiceDefSchema,
  type OpsTimelineEntry,
} from "@majhi/shared";
import type Database from "better-sqlite3";

/** The ops watch tables in `majhi.db` (migration 139). Everything the checks and incidents need survives a restart. */

export interface StoredService {
  id: string;
  org: string;
  def: OpsServiceDef;
  createdAt: string;
}

export interface CheckState {
  service: string;
  kind: OpsCheckKind;
  /** The last outcomes, oldest first: 1 answered, 0 failed. */
  recent: number[];
  fails: number;
  lastAt?: string;
  lastOk?: boolean;
  lastDetail: string;
  lastMs?: number;
  greenSince?: string;
  /** The last look could not tell (no network, no monitoring connection). */
  unknown: boolean;
  /** The failure is only a warning (a certificate with days left). */
  warn: boolean;
}

interface ServiceRow {
  id: string;
  org: string;
  def: string;
  created_at: string;
}

interface StateRow {
  service: string;
  kind: string;
  recent: string;
  fails: number;
  last_at: string | null;
  last_ok: number | null;
  last_detail: string;
  last_ms: number | null;
  green_since: string | null;
  unknown: number;
  warn: number;
}

interface IncidentRow {
  id: number;
  org: string;
  service: string | null;
  key: string;
  title: string;
  severity: string;
  status: string;
  finding: number | null;
  opened_at: string;
  acked_at: string | null;
  escalated_at: string | null;
  resolved_at: string | null;
  phone_at: string | null;
  phone_escalated_at: string | null;
  flaps: number;
  fix: string | null;
  timeline: string;
}

/** What the engine keeps on an incident besides what the owner sees. */
export interface StoredIncident extends OpsIncident {
  key: string;
  phoneAt?: string;
  phoneEscalatedAt?: string;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toIncident(r: IncidentRow): StoredIncident {
  const fix =
    r.fix === null ? undefined : parseJson<{ check: string; label: string } | undefined>(r.fix, undefined);
  const base = OpsIncidentSchema.parse({
    id: r.id,
    org: r.org,
    ...(r.service === null ? {} : { service: r.service }),
    ...(r.key.startsWith("watch:") ? { watch: r.key.slice("watch:".length) } : {}),
    title: r.title,
    severity: r.severity,
    status: r.status,
    ...(r.finding === null ? {} : { finding: r.finding }),
    openedAt: r.opened_at,
    ...(r.acked_at === null ? {} : { ackedAt: r.acked_at }),
    ...(r.escalated_at === null ? {} : { escalatedAt: r.escalated_at }),
    ...(r.resolved_at === null ? {} : { resolvedAt: r.resolved_at }),
    flaps: r.flaps,
    ...(fix === undefined ? {} : { fix }),
    timeline: fitTimeline(parseJson<OpsTimelineEntry[]>(r.timeline, [])),
  });
  return {
    ...base,
    key: r.key,
    ...(r.phone_at === null ? {} : { phoneAt: r.phone_at }),
    ...(r.phone_escalated_at === null ? {} : { phoneEscalatedAt: r.phone_escalated_at }),
  };
}

function toState(r: StateRow): CheckState {
  return {
    service: r.service,
    kind: r.kind as OpsCheckKind,
    recent: parseJson<number[]>(r.recent, []),
    fails: r.fails,
    ...(r.last_at === null ? {} : { lastAt: r.last_at }),
    ...(r.last_ok === null ? {} : { lastOk: r.last_ok === 1 }),
    lastDetail: r.last_detail,
    ...(r.last_ms === null ? {} : { lastMs: r.last_ms }),
    ...(r.green_since === null ? {} : { greenSince: r.green_since }),
    unknown: r.unknown === 1,
    warn: r.warn === 1,
  };
}

export class OpsRepo {
  constructor(private readonly db: Database.Database) {}

  // Services ------------------------------------------------------------------

  services(org?: string): StoredService[] {
    const rows = (
      org === undefined
        ? this.db.prepare("SELECT * FROM ops_services ORDER BY org, created_at, id").all()
        : this.db.prepare("SELECT * FROM ops_services WHERE org = ? ORDER BY created_at, id").all(org)
    ) as ServiceRow[];
    const out: StoredService[] = [];
    for (const r of rows) {
      const def = OpsServiceDefSchema.safeParse(parseJson<unknown>(r.def, null));
      if (def.success) out.push({ id: r.id, org: r.org, def: def.data, createdAt: r.created_at });
    }
    return out;
  }

  service(id: string): StoredService | undefined {
    return this.services().find((s) => s.id === id);
  }

  saveService(s: StoredService): void {
    this.db
      .prepare(
        `INSERT INTO ops_services (id, org, def, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET def = excluded.def`,
      )
      .run(s.id, s.org, JSON.stringify(s.def), s.createdAt);
  }

  removeService(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM ops_services WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM ops_state WHERE service = ?").run(id);
      this.db.prepare("DELETE FROM ops_samples WHERE service = ?").run(id);
    })();
  }

  // Check state ---------------------------------------------------------------

  state(service: string, kind: OpsCheckKind): CheckState | undefined {
    const row = this.db
      .prepare("SELECT * FROM ops_state WHERE service = ? AND kind = ?")
      .get(service, kind) as StateRow | undefined;
    return row === undefined ? undefined : toState(row);
  }

  states(service: string): CheckState[] {
    return (this.db.prepare("SELECT * FROM ops_state WHERE service = ?").all(service) as StateRow[]).map(
      toState,
    );
  }

  saveState(s: CheckState): void {
    this.db
      .prepare(
        `INSERT INTO ops_state (service, kind, recent, fails, last_at, last_ok, last_detail, last_ms, green_since, unknown, warn)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service, kind) DO UPDATE SET recent = excluded.recent, fails = excluded.fails,
           last_at = excluded.last_at, last_ok = excluded.last_ok, last_detail = excluded.last_detail,
           last_ms = excluded.last_ms, green_since = excluded.green_since, unknown = excluded.unknown,
           warn = excluded.warn`,
      )
      .run(
        s.service,
        s.kind,
        JSON.stringify(s.recent),
        s.fails,
        s.lastAt ?? null,
        s.lastOk === undefined ? null : s.lastOk ? 1 : 0,
        s.lastDetail,
        s.lastMs ?? null,
        s.greenSince ?? null,
        s.unknown ? 1 : 0,
        s.warn ? 1 : 0,
      );
  }

  // Samples -------------------------------------------------------------------

  addSample(service: string, at: string, ok: boolean, ms: number | undefined): void {
    this.db
      .prepare("INSERT INTO ops_samples (service, at, ok, ms) VALUES (?, ?, ?, ?)")
      .run(service, at, ok ? 1 : 0, ms ?? null);
  }

  /** Samples since a time, oldest first. */
  samples(service: string, since: string): OpsSample[] {
    return (
      this.db
        .prepare("SELECT at, ok, ms FROM ops_samples WHERE service = ? AND at >= ? ORDER BY at")
        .all(service, since) as { at: string; ok: number; ms: number | null }[]
    ).map((r) => ({ at: r.at, ok: r.ok === 1, ms: r.ms }));
  }

  pruneSamples(before: string): void {
    this.db.prepare("DELETE FROM ops_samples WHERE at < ?").run(before);
  }

  // Incidents -----------------------------------------------------------------

  incident(id: number): StoredIncident | undefined {
    const row = this.db.prepare("SELECT * FROM ops_incidents WHERE id = ?").get(id) as
      | IncidentRow
      | undefined;
    return row === undefined ? undefined : toIncident(row);
  }

  /** The newest incident a finding was made for. */
  byFinding(finding: number): StoredIncident | undefined {
    const row = this.db
      .prepare("SELECT * FROM ops_incidents WHERE finding = ? ORDER BY id DESC LIMIT 1")
      .get(finding) as IncidentRow | undefined;
    return row === undefined ? undefined : toIncident(row);
  }

  /** The newest incident with this key, open or not. */
  latestByKey(key: string): StoredIncident | undefined {
    const row = this.db
      .prepare("SELECT * FROM ops_incidents WHERE key = ? ORDER BY id DESC LIMIT 1")
      .get(key) as IncidentRow | undefined;
    return row === undefined ? undefined : toIncident(row);
  }

  open(): StoredIncident[] {
    return (
      this.db
        .prepare("SELECT * FROM ops_incidents WHERE status = 'open' ORDER BY id DESC")
        .all() as IncidentRow[]
    ).map(toIncident);
  }

  recent(limit: number): StoredIncident[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM ops_incidents WHERE status = 'resolved' ORDER BY resolved_at DESC, id DESC LIMIT ?",
        )
        .all(limit) as IncidentRow[]
    ).map(toIncident);
  }

  insertIncident(i: Omit<StoredIncident, "id">): number {
    const res = this.db
      .prepare(
        `INSERT INTO ops_incidents (org, service, key, title, severity, status, finding, opened_at, acked_at,
           escalated_at, resolved_at, phone_at, phone_escalated_at, flaps, fix, timeline)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.org,
        i.service ?? null,
        i.key,
        i.title,
        i.severity,
        i.status,
        i.finding ?? null,
        i.openedAt,
        i.ackedAt ?? null,
        i.escalatedAt ?? null,
        i.resolvedAt ?? null,
        i.phoneAt ?? null,
        i.phoneEscalatedAt ?? null,
        i.flaps,
        i.fix === undefined ? null : JSON.stringify(i.fix),
        JSON.stringify(fitTimeline(i.timeline)),
      );
    return Number(res.lastInsertRowid);
  }

  saveIncident(i: StoredIncident): void {
    this.db
      .prepare(
        `UPDATE ops_incidents SET title = ?, severity = ?, status = ?, finding = ?, opened_at = ?, acked_at = ?,
           escalated_at = ?, resolved_at = ?, phone_at = ?, phone_escalated_at = ?, flaps = ?, fix = ?, timeline = ?
         WHERE id = ?`,
      )
      .run(
        i.title,
        i.severity,
        i.status,
        i.finding ?? null,
        i.openedAt,
        i.ackedAt ?? null,
        i.escalatedAt ?? null,
        i.resolvedAt ?? null,
        i.phoneAt ?? null,
        i.phoneEscalatedAt ?? null,
        i.flaps,
        i.fix === undefined ? null : JSON.stringify(i.fix),
        JSON.stringify(fitTimeline(i.timeline)),
        i.id,
      );
  }

  // Settings ------------------------------------------------------------------

  setting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM ops_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO ops_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM ops_settings WHERE key = ?").run(key);
  }

  // Phone tokens and pushes -----------------------------------------------------

  addToken(jti: string, decision: string, action: string, expiresAt: string): void {
    this.db
      .prepare("INSERT INTO ops_phone_tokens (jti, decision, action, expires_at) VALUES (?, ?, ?, ?)")
      .run(jti, decision, action, expiresAt);
  }

  /** Marks one token used. True only for the first caller: a replay finds it used and gets false. */
  useToken(jti: string, at: string): boolean {
    return (
      this.db
        .prepare("UPDATE ops_phone_tokens SET used_at = ? WHERE jti = ? AND used_at IS NULL")
        .run(at, jti).changes === 1
    );
  }

  /** The decision's other buttons stop working once one is taken. */
  voidTokens(decision: string, at: string): void {
    this.db
      .prepare("UPDATE ops_phone_tokens SET used_at = ? WHERE decision = ? AND used_at IS NULL")
      .run(at, decision);
  }

  token(jti: string): { decision: string; action: string; expiresAt: string; used: boolean } | undefined {
    const row = this.db.prepare("SELECT * FROM ops_phone_tokens WHERE jti = ?").get(jti) as
      | { decision: string; action: string; expires_at: string; used_at: string | null }
      | undefined;
    return row === undefined
      ? undefined
      : { decision: row.decision, action: row.action, expiresAt: row.expires_at, used: row.used_at !== null };
  }

  pruneTokens(before: string): void {
    this.db.prepare("DELETE FROM ops_phone_tokens WHERE expires_at < ?").run(before);
  }

  clearTokens(): void {
    this.db.prepare("DELETE FROM ops_phone_tokens").run();
    this.db.prepare("DELETE FROM ops_phone_sent").run();
  }

  pushed(decision: string): boolean {
    return this.db.prepare("SELECT 1 FROM ops_phone_sent WHERE decision = ?").get(decision) !== undefined;
  }

  markPushed(decision: string, at: string): void {
    this.db.prepare("INSERT OR IGNORE INTO ops_phone_sent (decision, at) VALUES (?, ?)").run(decision, at);
  }

  prunePushed(before: string): void {
    this.db.prepare("DELETE FROM ops_phone_sent WHERE at < ?").run(before);
  }
}

/** Timeline lines fit the 8000 characters the views allow; one huge line must not break every list. */
function fitTimeline(timeline: OpsTimelineEntry[]): OpsTimelineEntry[] {
  return timeline.map((t) => (t.text.length <= 8000 ? t : { ...t, text: `${t.text.slice(0, 7999)}…` }));
}
