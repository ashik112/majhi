import type { Fact, FactStatus, MemoryAction, MemoryEvent, MemoryScope } from "@majhi/shared";
import type Database from "better-sqlite3";
import { EMBEDDING_DIMS } from "./migrations.ts";

interface FactRow {
  id: number;
  text: string;
  scope: string;
  task: string | null;
  agent: string | null;
  status: string;
  pinned: number;
  promoted: string | null;
  use_count: number;
  created_at: string;
  valid_from: string | null;
  valid_to: string | null;
  duplicate_of: number | null;
  decided_by: string | null;
}

interface EventRow {
  id: number;
  fact: number;
  action: string;
  actor: string;
  task: string | null;
  reason: string | null;
  confidence: number | null;
  provider: string | null;
  from_status: string | null;
  at: string;
  undone: number;
}

export interface NewFact {
  text: string;
  scope: MemoryScope;
  task?: string | undefined;
  agent?: string | undefined;
  status: FactStatus;
  pinned?: boolean | undefined;
  decidedBy?: string | undefined;
  duplicateOf?: number | undefined;
  at: string;
}

export interface FactFilter {
  scope?: MemoryScope | undefined;
  /** Any of these scopes. */
  scopes?: readonly MemoryScope[] | undefined;
  status?: FactStatus | undefined;
  task?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface NewEvent {
  fact: number;
  action: MemoryAction;
  actor: string;
  task?: string | undefined;
  reason?: string | undefined;
  confidence?: number | undefined;
  provider?: string | undefined;
  from?: FactStatus | undefined;
  at: string;
}

/** A vector match closer than this is noise: MiniLM puts unrelated sentences well below it. */
export const MIN_SIMILARITY = 0.25;

const COLUMNS =
  "id, text, scope, task, agent, status, pinned, promoted, use_count, created_at, valid_from, valid_to, duplicate_of, decided_by";

/** Words of a text as an FTS5 query: each one quoted, joined by OR. Undefined when there are none. */
export function ftsQuery(text: string, maxTerms = 48): string | undefined {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const unique = [...new Set(words)].slice(0, maxTerms);
  return unique.length === 0 ? undefined : unique.map((w) => `"${w}"`).join(" OR ");
}

function vectorBytes(vector: Float32Array): Buffer {
  if (vector.length !== EMBEDDING_DIMS) {
    throw new Error(`An embedding has ${EMBEDDING_DIMS} numbers, not ${vector.length}.`);
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Facts, their search indexes, the log and the per-task recalls, in `memory.db`. */
export class MemoryStore {
  constructor(private readonly db: Database.Database) {}

  insert(fact: NewFact): Fact {
    const row = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO facts (text, scope, task, agent, status, pinned, created_at, valid_from, duplicate_of, decided_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fact.text,
          fact.scope,
          fact.task ?? null,
          fact.agent ?? null,
          fact.status,
          fact.pinned === true ? 1 : 0,
          fact.at,
          fact.status === "active" ? fact.at : null,
          fact.duplicateOf ?? null,
          fact.decidedBy ?? null,
        );
      const id = Number(info.lastInsertRowid);
      // A bigint rowid: better-sqlite3 binds a plain number as a float, which the FTS table refuses.
      this.db.prepare("INSERT INTO facts_fts (rowid, text) VALUES (?, ?)").run(BigInt(id), fact.text);
      return this.db.prepare(`SELECT ${COLUMNS} FROM facts WHERE id = ?`).get(id) as FactRow;
    })();
    return toFact(row);
  }

  get(id: number): Fact | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM facts WHERE id = ?`).get(id) as FactRow | undefined;
    return row === undefined ? undefined : toFact(row);
  }

  /** Newest first. */
  list(filter: FactFilter = {}): Fact[] {
    const { where, params } = whereOf(filter);
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM facts ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 100, filter.offset ?? 0) as FactRow[];
    return rows.map(toFact);
  }

  scopesInUse(): MemoryScope[] {
    return (
      this.db.prepare("SELECT DISTINCT scope FROM facts ORDER BY scope").all() as { scope: string }[]
    ).map((r) => r.scope);
  }

  byIds(ids: readonly number[]): Fact[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM facts WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .all(...ids) as FactRow[];
    const byId = new Map(rows.map((r) => [r.id, toFact(r)]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  /** Active facts in these scopes with the pin set, oldest first. */
  pinned(scopes: readonly MemoryScope[]): Fact[] {
    if (scopes.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM facts WHERE status = 'active' AND pinned = 1 AND scope IN (${marks(scopes)}) ORDER BY id`,
      )
      .all(...scopes) as FactRow[];
    return rows.map(toFact);
  }

  setStatus(id: number, status: FactStatus, patch: { at: string; decidedBy?: string | undefined }): void {
    const active = status === "active";
    this.db
      .prepare(
        `UPDATE facts SET status = ?, decided_by = ?,
           valid_from = CASE WHEN ? THEN ? ELSE valid_from END,
           valid_to = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE valid_to END
         WHERE id = ?`,
      )
      .run(
        status,
        patch.decidedBy ?? null,
        active ? 1 : 0,
        patch.at,
        status === "retired" ? 1 : 0,
        patch.at,
        active ? 1 : 0,
        id,
      );
  }

  /**
   * Puts a fact back in the status it had, for undo. A fact that is not retired has no end, and one
   * that is pending or rejected has no start. An active one keeps the start it had.
   */
  restoreStatus(id: number, status: FactStatus, decidedBy: string): void {
    this.db
      .prepare(
        `UPDATE facts SET status = ?, decided_by = ?,
           valid_to = CASE WHEN ? = 'retired' THEN valid_to ELSE NULL END,
           valid_from = CASE WHEN ? IN ('pending', 'rejected') THEN NULL ELSE valid_from END
         WHERE id = ?`,
      )
      .run(status, decidedBy, status, status, id);
  }

  setDuplicateOf(id: number, of: number | null): void {
    this.db.prepare("UPDATE facts SET duplicate_of = ? WHERE id = ?").run(of, id);
  }

  setPinned(id: number, pinned: boolean): void {
    this.db.prepare("UPDATE facts SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  setPromoted(id: number, task: string | null): void {
    this.db.prepare("UPDATE facts SET promoted = ? WHERE id = ?").run(task, id);
  }

  // -------------------------------------------------------------------------
  // Search

  /** How many facts have the status in these scopes. */
  count(scopes: readonly MemoryScope[], status: FactStatus): number {
    if (scopes.length === 0) return 0;
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM facts WHERE status = ? AND scope IN (${marks(scopes)})`)
      .get(status, ...scopes) as { n: number };
    return row.n;
  }

  /** Ids of active facts in `scopes` matching the words, best bm25 first. */
  keywordIds(text: string, scopes: readonly MemoryScope[], status: FactStatus, limit: number): number[] {
    const query = ftsQuery(text);
    if (query === undefined || scopes.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT f.id AS id FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
         WHERE facts_fts MATCH ? AND f.status = ? AND f.scope IN (${marks(scopes)})
         ORDER BY bm25(facts_fts) LIMIT ?`,
      )
      .all(query, status, ...scopes, limit) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /**
   * Ids of the facts nearest to the vector among those in `scopes` with the status, nearest first,
   * leaving out those below `minCosine` (unit vectors: cosine = 1 - distance² / 2).
   */
  nearestIds(
    vector: Float32Array,
    scopes: readonly MemoryScope[],
    status: FactStatus,
    limit: number,
    minCosine = MIN_SIMILARITY,
  ): number[] {
    if (scopes.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT rowid AS id, distance FROM facts_vec
         WHERE embedding MATCH ? AND k = ?
           AND rowid IN (SELECT id FROM facts WHERE status = ? AND scope IN (${marks(scopes)}))
         ORDER BY distance`,
      )
      .all(vectorBytes(vector), limit, status, ...scopes) as { id: number | bigint; distance: number }[];
    return rows.filter((r) => 1 - (r.distance * r.distance) / 2 >= minCosine).map((r) => Number(r.id));
  }

  /**
   * The facts nearest to the vector among those in `scopes` with one of the statuses, nearest
   * first, with their cosine. `except` leaves out one fact (the one being compared).
   */
  nearest(
    vector: Float32Array,
    scopes: readonly MemoryScope[],
    statuses: readonly FactStatus[],
    limit: number,
    options: { minCosine?: number; except?: number } = {},
  ): { fact: Fact; cosine: number }[] {
    if (scopes.length === 0 || statuses.length === 0) return [];
    const minCosine = options.minCosine ?? MIN_SIMILARITY;
    const rows = this.db
      .prepare(
        `SELECT rowid AS id, distance FROM facts_vec
         WHERE embedding MATCH ? AND k = ?
           AND rowid IN (SELECT id FROM facts WHERE status IN (${marks(statuses)}) AND scope IN (${marks(scopes)}) AND id != ?)
         ORDER BY distance`,
      )
      .all(vectorBytes(vector), limit, ...statuses, ...scopes, options.except ?? 0) as {
      id: number | bigint;
      distance: number;
    }[];
    const near = rows
      .map((r) => ({ id: Number(r.id), cosine: 1 - (r.distance * r.distance) / 2 }))
      .filter((r) => r.cosine >= minCosine);
    const facts = new Map(this.byIds(near.map((r) => r.id)).map((f) => [f.id, f]));
    return near.flatMap((r) => {
      const fact = facts.get(r.id);
      return fact === undefined ? [] : [{ fact, cosine: r.cosine }];
    });
  }

  /** The stored vector of a fact, if it has one. */
  vectorOf(id: number): Float32Array | undefined {
    const row = this.db.prepare("SELECT embedding FROM facts_vec WHERE rowid = ?").get(BigInt(id)) as
      | { embedding: Buffer }
      | undefined;
    if (row === undefined) return undefined;
    const b = row.embedding;
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }

  setVector(id: number, vector: Float32Array): void {
    const bytes = vectorBytes(vector);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM facts_vec WHERE rowid = ?").run(BigInt(id));
      this.db.prepare("INSERT INTO facts_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(id), bytes);
    })();
  }

  /** Facts without a vector yet, oldest first: the embedder was not there when they were written. */
  withoutVector(limit: number): { id: number; text: string }[] {
    return this.db
      .prepare(`SELECT id, text FROM facts WHERE id NOT IN (SELECT rowid FROM facts_vec) ORDER BY id LIMIT ?`)
      .all(limit) as { id: number; text: string }[];
  }

  // -------------------------------------------------------------------------
  // Log

  logEvent(event: NewEvent): MemoryEvent {
    const info = this.db
      .prepare(
        `INSERT INTO memory_events (fact, action, actor, task, reason, confidence, provider, from_status, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.fact,
        event.action,
        event.actor,
        event.task ?? null,
        event.reason ?? null,
        event.confidence ?? null,
        event.provider ?? null,
        event.from ?? null,
        event.at,
      );
    const row = this.db
      .prepare("SELECT * FROM memory_events WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as EventRow;
    return toEvent(row);
  }

  getEvent(id: number): MemoryEvent | undefined {
    const row = this.db.prepare("SELECT * FROM memory_events WHERE id = ?").get(id) as EventRow | undefined;
    return row === undefined ? undefined : toEvent(row);
  }

  markUndone(id: number): void {
    this.db.prepare("UPDATE memory_events SET undone = 1 WHERE id = ?").run(id);
  }

  /** How many facts agents proposed in the task. The Housekeeper's candidates are not counted. */
  proposalsBy(task: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_events WHERE task = ? AND action = 'proposed' AND actor LIKE 'agent:%'",
      )
      .get(task) as { n: number };
    return row.n;
  }

  /** Newest first. */
  events(filter: {
    task?: string | undefined;
    fact?: number | undefined;
    limit?: number;
    offset?: number;
  }): MemoryEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.task !== undefined) {
      where.push("task = ?");
      params.push(filter.task);
    }
    if (filter.fact !== undefined) {
      where.push("fact = ?");
      params.push(filter.fact);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_events ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
         ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit ?? 100, filter.offset ?? 0) as EventRow[];
    return rows.map(toEvent);
  }

  // -------------------------------------------------------------------------
  // What a task was given

  /** The active facts recorded for the task, in the order they were recalled. */
  recalled(task: string): Fact[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS.split(", ")
          .map((c) => `f.${c}`)
          .join(", ")} FROM task_recalls r JOIN facts f ON f.id = r.fact
         WHERE r.task = ? AND f.status = 'active' ORDER BY r.rank`,
      )
      .all(task) as FactRow[];
    return rows.map(toFact);
  }

  /** Replaces the task's recalls. A fact new to the task gets its use count up by one. */
  recordRecall(task: string, ids: readonly number[]): void {
    this.db.transaction(() => {
      const known = new Set(
        (this.db.prepare("SELECT fact FROM task_recalls WHERE task = ?").all(task) as { fact: number }[]).map(
          (r) => r.fact,
        ),
      );
      this.db.prepare("DELETE FROM task_recalls WHERE task = ?").run(task);
      const insert = this.db.prepare("INSERT INTO task_recalls (task, fact, rank) VALUES (?, ?, ?)");
      const bump = this.db.prepare("UPDATE facts SET use_count = use_count + 1 WHERE id = ?");
      ids.forEach((id, rank) => {
        insert.run(task, id, rank);
        if (!known.has(id)) bump.run(id);
      });
    })();
  }

  /** Counts a fact given to a task by hand (an agent's `recall`), once per task. */
  noteUse(task: string, ids: readonly number[]): void {
    this.db.transaction(() => {
      const next = (
        this.db
          .prepare("SELECT COALESCE(MAX(rank), -1) + 1 AS n FROM task_recalls WHERE task = ?")
          .get(task) as { n: number }
      ).n;
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO task_recalls (task, fact, rank) VALUES (?, ?, ?)",
      );
      const bump = this.db.prepare("UPDATE facts SET use_count = use_count + 1 WHERE id = ?");
      let rank = next;
      for (const id of ids) {
        if (insert.run(task, id, rank).changes > 0) {
          bump.run(id);
          rank += 1;
        }
      }
    })();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

function marks(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function whereOf(filter: FactFilter): { where: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (filter.scope !== undefined) {
    parts.push("scope = ?");
    params.push(filter.scope);
  }
  if (filter.scopes !== undefined) {
    // No scope allowed: nothing matches.
    parts.push(filter.scopes.length === 0 ? "0" : `scope IN (${marks(filter.scopes)})`);
    params.push(...filter.scopes);
  }
  if (filter.status !== undefined) {
    parts.push("status = ?");
    params.push(filter.status);
  }
  if (filter.task !== undefined) {
    parts.push("task = ?");
    params.push(filter.task);
  }
  return { where: parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`, params };
}

function toFact(r: FactRow): Fact {
  return {
    id: r.id,
    text: r.text,
    scope: r.scope,
    ...(r.task === null ? {} : { task: r.task }),
    ...(r.agent === null ? {} : { agent: r.agent }),
    status: r.status as FactStatus,
    pinned: r.pinned === 1,
    ...(r.promoted === null ? {} : { promoted: r.promoted }),
    use_count: r.use_count,
    created_at: r.created_at,
    ...(r.valid_from === null ? {} : { valid_from: r.valid_from }),
    ...(r.valid_to === null ? {} : { valid_to: r.valid_to }),
    ...(r.duplicate_of === null ? {} : { duplicate_of: r.duplicate_of }),
    ...(r.decided_by === null ? {} : { decided_by: r.decided_by }),
  };
}

function toEvent(r: EventRow): MemoryEvent {
  return {
    id: r.id,
    fact: r.fact,
    action: r.action as MemoryAction,
    actor: r.actor,
    ...(r.task === null ? {} : { task: r.task }),
    ...(r.reason === null ? {} : { reason: r.reason }),
    ...(r.confidence === null ? {} : { confidence: r.confidence }),
    ...(r.provider === null ? {} : { provider: r.provider }),
    ...(r.from_status === null ? {} : { from: r.from_status as FactStatus }),
    at: r.at,
    undone: r.undone === 1,
  };
}
