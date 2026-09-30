import {
  type BriefSource,
  type MemoryScope,
  type ProjectBrief,
  RECORD_SECTIONS,
  type RecordRepo,
  RecordRepoSchema,
  type TaskRecord,
  type Thread,
  type ThreadStatus,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";
import { EMBEDDING_DIMS } from "./migrations.ts";
import { ftsQuery, MIN_SIMILARITY } from "./store.ts";

interface RecordRow {
  id: number;
  task: string;
  title: string;
  org: string | null;
  projects: string;
  asked: string;
  done: string;
  decisions: string;
  outcome: string;
  left_open: string;
  repos: string;
  agent: string | null;
  created_at: string;
  updated_at: string;
}

interface BriefRow {
  project: string;
  version: number;
  body: string;
  source: string;
  task: string | null;
  restored_from: number | null;
  agent: string | null;
  created_at: string;
}

interface ThreadRow {
  id: number;
  text: string;
  project: string | null;
  org: string | null;
  task: string;
  follow_up: string | null;
  status: string;
  closed_by: string | null;
  closed_reason: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface NewRecord {
  task: string;
  title: string;
  org?: string | undefined;
  projects: readonly string[];
  asked: string;
  done: string;
  decisions: string;
  outcome: string;
  left: string;
  repos: readonly RecordRepo[];
  agent?: string | undefined;
  /** The scopes it is seen in: its org and its projects. */
  scopes: readonly MemoryScope[];
  at: string;
}

export interface NewThread {
  text: string;
  project?: string | undefined;
  org?: string | undefined;
  task: string;
  followUp?: string | undefined;
  at: string;
}

const StringsSchema = z.array(z.string());
const ReposSchema = z.array(RecordRepoSchema);

/** The words a record is searched by. */
export function recordText(r: Pick<TaskRecord, (typeof RECORD_SECTIONS)[number]>): string {
  return RECORD_SECTIONS.map((s) => r[s]).join("\n");
}

function vectorBytes(vector: Float32Array): Buffer {
  if (vector.length !== EMBEDDING_DIMS) {
    throw new Error(`An embedding has ${EMBEDDING_DIMS} numbers, not ${vector.length}.`);
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

const marks = (values: readonly unknown[]) => values.map(() => "?").join(", ");

/** Task records, project briefs, open threads and what each task got in TASK.md, in `memory.db`. */
export class RecordStore {
  constructor(private readonly db: Database.Database) {}

  // -------------------------------------------------------------------------
  // Task records

  /**
   * Writes the task's record, or replaces the one it has (same id, new text). Its scopes and search
   * indexes follow. Returns the record and whether it was new.
   */
  putRecord(input: NewRecord): { record: TaskRecord; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT id, created_at FROM task_records WHERE task = ?")
        .get(input.task) as { id: number; created_at: string } | undefined;
      const values = [
        input.title,
        input.org ?? null,
        JSON.stringify(input.projects),
        input.asked,
        input.done,
        input.decisions,
        input.outcome,
        input.left,
        JSON.stringify(input.repos),
        input.agent ?? null,
      ];
      let id: number;
      if (existing === undefined) {
        const info = this.db
          .prepare(
            `INSERT INTO task_records (task, title, org, projects, asked, done, decisions, outcome, left_open, repos, agent, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(input.task, ...values, input.at, input.at);
        id = Number(info.lastInsertRowid);
      } else {
        id = existing.id;
        this.db
          .prepare(
            `UPDATE task_records SET title = ?, org = ?, projects = ?, asked = ?, done = ?, decisions = ?, outcome = ?,
               left_open = ?, repos = ?, agent = ?, updated_at = ? WHERE id = ?`,
          )
          .run(...values, input.at, id);
        this.db.prepare("DELETE FROM records_fts WHERE rowid = ?").run(BigInt(id));
        this.db.prepare("DELETE FROM records_vec WHERE rowid = ?").run(BigInt(id));
        this.db.prepare("DELETE FROM record_scopes WHERE record = ?").run(id);
      }
      this.db
        .prepare("INSERT INTO records_fts (rowid, title, body) VALUES (?, ?, ?)")
        .run(BigInt(id), input.title, recordText(input));
      const scope = this.db.prepare("INSERT OR IGNORE INTO record_scopes (record, scope) VALUES (?, ?)");
      for (const s of input.scopes) scope.run(id, s);
      const record = this.recordById(id);
      if (record === undefined) throw new Error(`Record ${id} was not written.`);
      return { record, created: existing === undefined };
    })();
  }

  record(task: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM task_records WHERE task = ?").get(task) as
      | RecordRow
      | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  recordById(id: number): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM task_records WHERE id = ?").get(id) as RecordRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Records seen in any of `scopes` (undefined: all), newest first. `project` keeps those of one
   * project.
   */
  records(filter: {
    scopes?: readonly MemoryScope[] | undefined;
    project?: string | undefined;
    limit: number;
  }): TaskRecord[] {
    const { where, params } = recordWhere(filter.scopes, filter.project);
    const rows = this.db
      .prepare(`SELECT * FROM task_records r ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
      .all(...params, filter.limit) as RecordRow[];
    return rows.map(toRecord);
  }

  recordsByIds(ids: readonly number[]): TaskRecord[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM task_records WHERE id IN (${marks(ids)})`)
      .all(...ids) as RecordRow[];
    const byId = new Map(rows.map((r) => [r.id, toRecord(r)]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  countRecords(scopes: readonly MemoryScope[] | undefined, project?: string): number {
    const { where, params } = recordWhere(scopes, project);
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM task_records r ${where}`).get(...params) as { n: number }
    ).n;
  }

  /** Record ids matching the words, best bm25 first, among those seen in `scopes`. */
  recordKeywordIds(
    text: string,
    scopes: readonly MemoryScope[] | undefined,
    project: string | undefined,
    limit: number,
  ): number[] {
    const query = ftsQuery(text);
    if (query === undefined) return [];
    const { where, params } = recordWhere(scopes, project);
    const rows = this.db
      .prepare(
        `SELECT r.id AS id FROM records_fts JOIN task_records r ON r.id = records_fts.rowid
         ${where === "" ? "WHERE" : `${where} AND`} records_fts MATCH ?
         ORDER BY bm25(records_fts) LIMIT ?`,
      )
      .all(...params, query, limit) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /** Record ids nearest the vector among those seen in `scopes`, nearest first. */
  recordNearestIds(
    vector: Float32Array,
    scopes: readonly MemoryScope[] | undefined,
    project: string | undefined,
    limit: number,
  ): number[] {
    const { where, params } = recordWhere(scopes, project);
    const rows = this.db
      .prepare(
        `SELECT rowid AS id, distance FROM records_vec
         WHERE embedding MATCH ? AND k = ? AND rowid IN (SELECT r.id FROM task_records r ${where})
         ORDER BY distance`,
      )
      .all(vectorBytes(vector), limit, ...params) as { id: number | bigint; distance: number }[];
    return rows.filter((r) => 1 - (r.distance * r.distance) / 2 >= MIN_SIMILARITY).map((r) => Number(r.id));
  }

  setRecordVector(id: number, vector: Float32Array): void {
    const bytes = vectorBytes(vector);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM records_vec WHERE rowid = ?").run(BigInt(id));
      this.db.prepare("INSERT INTO records_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(id), bytes);
    })();
  }

  recordsWithoutVector(limit: number): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_records WHERE id NOT IN (SELECT rowid FROM records_vec) ORDER BY id LIMIT ?`,
      )
      .all(limit) as RecordRow[];
    return rows.map(toRecord);
  }

  // -------------------------------------------------------------------------
  // Project briefs

  /** Every version of the project's brief, newest first. */
  briefs(project: string): ProjectBrief[] {
    const rows = this.db
      .prepare("SELECT * FROM project_briefs WHERE project = ? ORDER BY version DESC")
      .all(project) as BriefRow[];
    return rows.map(toBrief);
  }

  brief(project: string, version?: number): ProjectBrief | undefined {
    const row = (
      version === undefined
        ? this.db
            .prepare("SELECT * FROM project_briefs WHERE project = ? ORDER BY version DESC LIMIT 1")
            .get(project)
        : this.db
            .prepare("SELECT * FROM project_briefs WHERE project = ? AND version = ?")
            .get(project, version)
    ) as BriefRow | undefined;
    return row === undefined ? undefined : toBrief(row);
  }

  /** Adds the next version. Earlier versions are never changed. */
  addBrief(input: {
    project: string;
    body: string;
    source: BriefSource;
    task?: string | undefined;
    restoredFrom?: number | undefined;
    agent?: string | undefined;
    at: string;
  }): ProjectBrief {
    return this.db.transaction(() => {
      const next = (
        this.db
          .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM project_briefs WHERE project = ?")
          .get(input.project) as { n: number }
      ).n;
      this.db
        .prepare(
          `INSERT INTO project_briefs (project, version, body, source, task, restored_from, agent, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.project,
          next,
          input.body,
          input.source,
          input.task ?? null,
          input.restoredFrom ?? null,
          input.agent ?? null,
          input.at,
        );
      const brief = this.brief(input.project, next);
      if (brief === undefined) throw new Error(`Brief ${input.project} v${next} was not written.`);
      return brief;
    })();
  }

  // -------------------------------------------------------------------------
  // Threads

  addThread(input: NewThread): Thread {
    const info = this.db
      .prepare(
        `INSERT INTO threads (text, project, org, task, follow_up, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        input.text,
        input.project ?? null,
        input.org ?? null,
        input.task,
        input.followUp ?? null,
        input.at,
      );
    const thread = this.thread(Number(info.lastInsertRowid));
    if (thread === undefined) throw new Error("The thread was not written.");
    return thread;
  }

  thread(id: number): Thread | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
    return row === undefined ? undefined : toThread(row);
  }

  /** Newest first. `projects` keeps threads of those projects (and none without one). */
  threads(filter: {
    projects?: readonly string[] | undefined;
    status?: ThreadStatus | undefined;
    task?: string | undefined;
    followUp?: string | undefined;
    limit?: number | undefined;
  }): Thread[] {
    const parts: string[] = [];
    const params: string[] = [];
    if (filter.projects !== undefined) {
      parts.push(filter.projects.length === 0 ? "0" : `project IN (${marks(filter.projects)})`);
      params.push(...filter.projects);
    }
    if (filter.status !== undefined) {
      parts.push("status = ?");
      params.push(filter.status);
    }
    if (filter.task !== undefined) {
      parts.push("task = ?");
      params.push(filter.task);
    }
    if (filter.followUp !== undefined) {
      parts.push("follow_up = ?");
      params.push(filter.followUp);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM threads ${parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, filter.limit ?? 200) as ThreadRow[];
    return rows.map(toThread);
  }

  closeThread(id: number, by: string, reason: string | undefined, at: string): void {
    this.db
      .prepare(
        "UPDATE threads SET status = 'closed', closed_by = ?, closed_reason = ?, closed_at = ? WHERE id = ?",
      )
      .run(by, reason ?? null, at, id);
  }

  reopenThread(id: number): void {
    this.db
      .prepare(
        "UPDATE threads SET status = 'open', closed_by = NULL, closed_reason = NULL, closed_at = NULL WHERE id = ?",
      )
      .run(id);
  }

  /** Drops the open threads a task opened, before its record is written again. Closed ones stay. */
  dropOpenThreadsOf(task: string): number {
    return this.db.prepare("DELETE FROM threads WHERE task = ? AND status = 'open'").run(task).changes;
  }

  // -------------------------------------------------------------------------
  // What a task got in TASK.md, and one-time steps

  taskMemory(task: string): string | undefined {
    const row = this.db.prepare("SELECT text FROM task_memory WHERE task = ?").get(task) as
      | { text: string }
      | undefined;
    return row?.text;
  }

  setTaskMemory(task: string, text: string, at: string): void {
    this.db
      .prepare(
        "INSERT INTO task_memory (task, text, at) VALUES (?, ?, ?) ON CONFLICT (task) DO UPDATE SET text = excluded.text, at = excluded.at",
      )
      .run(task, text, at);
  }

  meta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
}

function recordWhere(
  scopes: readonly MemoryScope[] | undefined,
  project: string | undefined,
): { where: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (scopes !== undefined) {
    parts.push(
      scopes.length === 0
        ? "0"
        : `r.id IN (SELECT record FROM record_scopes WHERE scope IN (${marks(scopes)}))`,
    );
    params.push(...scopes);
  }
  if (project !== undefined) {
    parts.push("r.id IN (SELECT record FROM record_scopes WHERE scope = ?)");
    params.push(`project:${project}`);
  }
  return { where: parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`, params };
}

function toRecord(r: RecordRow): TaskRecord {
  return {
    id: r.id,
    task: r.task,
    title: r.title,
    ...(r.org === null ? {} : { org: r.org }),
    projects: StringsSchema.parse(JSON.parse(r.projects)),
    asked: r.asked,
    done: r.done,
    decisions: r.decisions,
    outcome: r.outcome,
    left: r.left_open,
    repos: ReposSchema.parse(JSON.parse(r.repos)),
    ...(r.agent === null ? {} : { agent: r.agent }),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function toBrief(r: BriefRow): ProjectBrief {
  return {
    project: r.project,
    version: r.version,
    body: r.body,
    source: r.source as BriefSource,
    ...(r.task === null ? {} : { task: r.task }),
    ...(r.restored_from === null ? {} : { restored_from: r.restored_from }),
    ...(r.agent === null ? {} : { agent: r.agent }),
    created_at: r.created_at,
  };
}

function toThread(r: ThreadRow): Thread {
  return {
    id: r.id,
    text: r.text,
    ...(r.project === null ? {} : { project: r.project }),
    ...(r.org === null ? {} : { org: r.org }),
    task: r.task,
    ...(r.follow_up === null ? {} : { follow_up: r.follow_up }),
    status: r.status as ThreadStatus,
    ...(r.closed_by === null ? {} : { closed_by: r.closed_by }),
    ...(r.closed_reason === null ? {} : { closed_reason: r.closed_reason }),
    created_at: r.created_at,
    ...(r.closed_at === null ? {} : { closed_at: r.closed_at }),
  };
}
