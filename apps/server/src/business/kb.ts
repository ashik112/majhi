import {
  type Attachment,
  AttachmentSchema,
  type KbEntry,
  KbEntrySchema,
  type KbGet,
  type KbKind,
  type KbList,
  type KbListInput,
  type KbRow,
  type KbSearch,
  type KbUpsertInput,
  type KbUpsertResult,
  type KbVersion,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";
import { UserError } from "../errors.ts";
import { cosine } from "../memory/embedder.ts";
import { fuse } from "../memory/search.ts";
import { ftsQuery } from "../memory/store.ts";
import {
  actorBy,
  type BusinessActor,
  canChange,
  canSee,
  cleanTags,
  missing,
  orgWhere,
  parseList,
  targetOrg,
} from "./scope.ts";

/** The knowledge base (SPEC 5.19): entries per workspace or for the business, versioned, searchable. */

interface Row {
  id: number;
  org: string | null;
  kind: string;
  title: string;
  body: string;
  tags: string;
  sources: string;
  files: string;
  verified: number;
  verified_at: string | null;
  version: number;
  by: string;
  embedding: Buffer | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  entry: number;
  version: number;
  kind: string;
  title: string;
  body: string;
  tags: string;
  sources: string;
  verified: number;
  change: string;
  by: string;
  at: string;
}

export interface KbDeps {
  db: Database.Database;
  now?: () => Date;
  /** Unit vectors for the texts, or undefined when the model is not there. */
  embed?: (texts: readonly string[]) => Promise<Float32Array[] | undefined>;
  /** Moves an upload into a folder and returns its attachment. */
  takeUpload?: (id: string, dir: string) => Promise<Attachment>;
  /** Where the files of an entry live. */
  filesDir: (entry: number) => string;
  /** Whether a workspace exists (`private` too). */
  orgExists: (org: string) => Promise<boolean>;
  changed?: () => void;
}

const EXCERPT = 200;
/** What the embedding sees of an entry: its title and the start of its text. */
const EMBED_CHARS = 2_000;
/** A hit in search carries at most this much text; kb.get has the rest. */
const HIT_BODY_MAX = 3_000;
/** Vectors closer than this to the query are not near at all. */
const MIN_COSINE = 0.2;
const CANDIDATES = 20;

const FilesSchema = z.array(AttachmentSchema);

function vectorBytes(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function bytesVector(b: Buffer): Float32Array {
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

function filesOf(raw: string): Attachment[] {
  try {
    const parsed = FilesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function toEntry(r: Row): KbEntry {
  return KbEntrySchema.parse({
    id: r.id,
    ...(r.org === null ? {} : { org: r.org }),
    kind: r.kind,
    title: r.title,
    body: r.body,
    tags: parseList(r.tags),
    sources: parseList(r.sources),
    files: filesOf(r.files),
    verified: r.verified === 1,
    ...(r.verified_at === null ? {} : { verifiedAt: r.verified_at }),
    version: r.version,
    by: r.by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function excerptOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
}

function toRow(entry: KbEntry): KbRow {
  const { body, ...rest } = entry;
  return { ...rest, excerpt: excerptOf(body) };
}

export class KbService {
  private readonly db: Database.Database;

  constructor(private readonly deps: KbDeps) {
    this.db = deps.db;
  }

  private at(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private row(id: number): Row | undefined {
    return this.db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as Row | undefined;
  }

  /** The entry, or a 404 for one that is not there or that the actor may not see. */
  private visible(id: number, actor: BusinessActor): Row {
    const found = this.row(id);
    if (found === undefined || !canSee(actor, found.org)) throw missing("Entry", id);
    return found;
  }

  private versionsOf(id: number): KbVersion[] {
    return (
      this.db
        .prepare(
          "SELECT version, kind, title, verified, change, by, at FROM kb_versions WHERE entry = ? ORDER BY version DESC",
        )
        .all(id) as VersionRow[]
    ).map((v) => ({
      version: v.version,
      title: v.title,
      kind: v.kind as KbKind,
      by: v.by,
      at: v.at,
      verified: v.verified === 1,
      change: v.change as KbVersion["change"],
    }));
  }

  private snapshot(r: Row, change: KbVersion["change"], by: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO kb_versions (entry, version, kind, title, body, tags, sources, verified, change, by, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.version, r.kind, r.title, r.body, r.tags, r.sources, r.verified, change, by, at);
  }

  private reindex(r: Row): void {
    this.db.prepare("DELETE FROM kb_fts WHERE rowid = ?").run(r.id);
    if (r.removed_at !== null) return;
    this.db
      .prepare("INSERT INTO kb_fts (rowid, title, body, tags) VALUES (?, ?, ?, ?)")
      .run(r.id, r.title, r.body, parseList(r.tags).join(" "));
  }

  /** Computes and stores the vector of an entry. A model that is not there leaves it for later. */
  private async embedEntry(id: number): Promise<void> {
    const embed = this.deps.embed;
    const r = this.row(id);
    if (embed === undefined || r === undefined || r.removed_at !== null) return;
    try {
      const [vector] = (await embed([`${r.title}\n${r.body.slice(0, EMBED_CHARS)}`])) ?? [];
      if (vector === undefined) return;
      this.db
        .prepare("UPDATE kb_entries SET embedding = ? WHERE id = ? AND version = ?")
        .run(vectorBytes(vector), id, r.version);
    } catch {
      // Keywords still find it; the vector is filled in on the next change.
    }
  }

  list(input: KbListInput, actor: BusinessActor): KbList {
    const scope = orgWhere("org", actor, input);
    const parts = [scope.sql, input.removed === true ? "removed_at IS NOT NULL" : "removed_at IS NULL"];
    const args: unknown[] = [...scope.args];
    if (input.kind !== undefined) {
      parts.push("kind = ?");
      args.push(input.kind);
    }
    if (input.verified !== undefined) {
      parts.push("verified = ?");
      args.push(input.verified ? 1 : 0);
    }
    if (input.tag !== undefined) {
      parts.push("EXISTS (SELECT 1 FROM json_each(kb_entries.tags) WHERE value = ?)");
      args.push(input.tag.toLowerCase());
    }
    const where = parts.join(" AND ");
    const total = (
      this.db.prepare(`SELECT count(*) AS n FROM kb_entries WHERE ${where}`).get(...args) as { n: number }
    ).n;
    const rows = this.db
      .prepare(`SELECT * FROM kb_entries WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...args, input.limit) as Row[];
    return { entries: rows.map((r) => toRow(toEntry(r))), total };
  }

  get(id: number, version: number | undefined, actor: BusinessActor): KbGet {
    const r = this.visible(id, actor);
    const entry = toEntry(r);
    if (version === undefined || version === r.version) {
      return { entry, versions: this.versionsOf(id), removed: r.removed_at !== null };
    }
    const old = this.db
      .prepare("SELECT * FROM kb_versions WHERE entry = ? AND version = ?")
      .get(id, version) as VersionRow | undefined;
    if (old === undefined) throw new UserError(`Entry ${id} has no version ${version}.`, 404);
    return {
      entry: {
        ...entry,
        kind: old.kind as KbKind,
        title: old.title,
        body: old.body,
        tags: parseList(old.tags),
        sources: parseList(old.sources),
        verified: old.verified === 1,
        version: old.version,
        by: old.by,
        updatedAt: old.at,
      },
      versions: this.versionsOf(id),
      removed: r.removed_at !== null,
    };
  }

  async upsert(input: KbUpsertInput, actor: BusinessActor): Promise<KbUpsertResult> {
    const org = targetOrg(actor, input.org);
    if (org !== null && !(await this.deps.orgExists(org))) {
      throw new UserError(`Workspace ${org} does not exist.`, 404);
    }
    if (input.uploads.length > 0 && this.deps.takeUpload === undefined) {
      throw new UserError("Files cannot be attached here.");
    }
    const at = this.at();
    const by = actorBy(actor);
    const owner = actor.kind === "owner";
    const tags = cleanTags(input.tags);
    const existing = input.id === undefined ? undefined : this.visible(input.id, actor);
    let id = 0;
    let created = false;
    if (existing !== undefined) {
      if (existing.removed_at !== null)
        throw new UserError(`Entry ${existing.id} was removed. Restore it first.`, 409);
      if (!canChange(actor, existing.org))
        throw new UserError(`Entry ${existing.id} belongs to another scope.`, 409);
      if (!owner && existing.verified === 1) {
        throw new UserError(
          `Entry ${existing.id} is verified by the owner. Propose the change as a new entry; the owner merges it.`,
          409,
        );
      }
      id = existing.id;
      const verified = owner ? (input.verified ?? existing.verified === 1) : false;
      const same =
        existing.org === org &&
        existing.kind === input.kind &&
        existing.title === input.title &&
        existing.body === input.body &&
        existing.tags === JSON.stringify(tags) &&
        existing.sources === JSON.stringify(input.sources) &&
        (existing.verified === 1) === verified &&
        input.uploads.length === 0;
      if (same) return { entry: toEntry(existing), created: false };
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE kb_entries SET org = ?, kind = ?, title = ?, body = ?, tags = ?, sources = ?,
               verified = ?, verified_at = ?, version = version + 1, by = ?, embedding = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            org,
            input.kind,
            input.title,
            input.body,
            JSON.stringify(tags),
            JSON.stringify(input.sources),
            verified ? 1 : 0,
            verified ? (existing.verified === 1 ? existing.verified_at : at) : null,
            by,
            at,
            id,
          );
        const next = this.row(id) as Row;
        this.snapshot(next, "edit", by, at);
        this.reindex(next);
      })();
    } else {
      created = true;
      const verified = owner ? (input.verified ?? true) : false;
      this.db.transaction(() => {
        const info = this.db
          .prepare(
            `INSERT INTO kb_entries (org, kind, title, body, tags, sources, files, verified, verified_at, version, by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            org,
            input.kind,
            input.title,
            input.body,
            JSON.stringify(tags),
            JSON.stringify(input.sources),
            verified ? 1 : 0,
            verified ? at : null,
            by,
            at,
            at,
          );
        id = Number(info.lastInsertRowid);
        const next = this.row(id) as Row;
        this.snapshot(next, "create", by, at);
        this.reindex(next);
      })();
    }
    const take = this.deps.takeUpload;
    if (take !== undefined && input.uploads.length > 0) {
      const taken: Attachment[] = [];
      for (const upload of input.uploads) taken.push(await take(upload, this.deps.filesDir(id)));
      const now = this.row(id) as Row;
      this.db
        .prepare("UPDATE kb_entries SET files = ? WHERE id = ?")
        .run(JSON.stringify([...filesOf(now.files), ...taken]), id);
    }
    await this.embedEntry(id);
    this.deps.changed?.();
    return { entry: toEntry(this.row(id) as Row), created };
  }

  /** The owner checks an entry, or takes the check back. */
  verify(id: number, verified: boolean, actor: BusinessActor): KbGet {
    if (actor.kind !== "owner") throw new UserError("Only the owner verifies an entry.", 409);
    const r = this.visible(id, actor);
    if ((r.verified === 1) === verified) return this.get(id, undefined, actor);
    const at = this.at();
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE kb_entries SET verified = ?, verified_at = ?, version = version + 1, by = ?, updated_at = ? WHERE id = ?",
        )
        .run(verified ? 1 : 0, verified ? at : null, "owner", at, id);
      this.snapshot(this.row(id) as Row, "verify", "owner", at);
    })();
    this.deps.changed?.();
    return this.get(id, undefined, actor);
  }

  remove(id: number, actor: BusinessActor): KbGet {
    if (actor.kind !== "owner") throw new UserError("Only the owner removes an entry.", 409);
    const r = this.visible(id, actor);
    if (r.removed_at !== null) return this.get(id, undefined, actor);
    const at = this.at();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE kb_entries SET removed_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(at, at, id);
      const next = this.row(id) as Row;
      this.snapshot(next, "remove", "owner", at);
      this.reindex(next);
    })();
    this.deps.changed?.();
    return this.get(id, undefined, actor);
  }

  /** Brings a removed entry back, or an older version back as a new version. */
  async restore(id: number, version: number | undefined, actor: BusinessActor): Promise<KbGet> {
    if (actor.kind !== "owner") throw new UserError("Only the owner restores an entry.", 409);
    const r = this.visible(id, actor);
    const at = this.at();
    let old: VersionRow | undefined;
    if (version !== undefined) {
      old = this.db.prepare("SELECT * FROM kb_versions WHERE entry = ? AND version = ?").get(id, version) as
        | VersionRow
        | undefined;
      if (old === undefined) throw new UserError(`Entry ${id} has no version ${version}.`, 404);
    } else if (r.removed_at === null) {
      throw new UserError(`Entry ${id} is not removed. Pick a version to bring back.`, 409);
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE kb_entries SET removed_at = NULL, version = version + 1, updated_at = ?, by = 'owner', embedding = NULL,
             kind = ?, title = ?, body = ?, tags = ?, sources = ?, verified = ?, verified_at = ?
           WHERE id = ?`,
        )
        .run(
          at,
          old?.kind ?? r.kind,
          old?.title ?? r.title,
          old?.body ?? r.body,
          old?.tags ?? r.tags,
          old?.sources ?? r.sources,
          old?.verified ?? r.verified,
          (old?.verified ?? r.verified) === 1 ? (r.verified_at ?? at) : null,
          id,
        );
      const next = this.row(id) as Row;
      this.snapshot(next, "restore", "owner", at);
      this.reindex(next);
    })();
    await this.embedEntry(id);
    this.deps.changed?.();
    return this.get(id, undefined, actor);
  }

  /** Keywords and meaning together, best first, inside what the actor may see. */
  async search(
    input: {
      query: string;
      org?: string | undefined;
      businessOnly?: boolean | undefined;
      kind?: KbKind | undefined;
      limit: number;
    },
    actor: BusinessActor,
  ): Promise<KbSearch> {
    const scope = orgWhere("e.org", actor, input);
    const parts = [scope.sql, "e.removed_at IS NULL"];
    const args: unknown[] = [...scope.args];
    if (input.kind !== undefined) {
      parts.push("e.kind = ?");
      args.push(input.kind);
    }
    const where = parts.join(" AND ");
    const match = ftsQuery(input.query);
    const keyword =
      match === undefined
        ? []
        : (
            this.db
              .prepare(
                `SELECT e.id AS id FROM kb_fts JOIN kb_entries e ON e.id = kb_fts.rowid
                 WHERE kb_fts MATCH ? AND ${where} ORDER BY bm25(kb_fts, 4.0, 1.0, 2.0) LIMIT ?`,
              )
              .all(match, ...args, CANDIDATES) as { id: number }[]
          ).map((r) => r.id);
    let nearest: number[] = [];
    let keywordOnly = true;
    if (this.deps.embed !== undefined) {
      try {
        const [vector] = (await this.deps.embed([input.query])) ?? [];
        if (vector !== undefined) {
          keywordOnly = false;
          const rows = this.db
            .prepare(
              `SELECT e.id AS id, e.embedding AS embedding FROM kb_entries e WHERE e.embedding IS NOT NULL AND ${where}`,
            )
            .all(...args) as { id: number; embedding: Buffer }[];
          nearest = rows
            .map((r) => ({ id: r.id, score: cosine(vector, bytesVector(r.embedding)) }))
            .filter((r) => r.score >= MIN_COSINE)
            .sort((a, b) => b.score - a.score || a.id - b.id)
            .slice(0, CANDIDATES)
            .map((r) => r.id);
        }
      } catch {
        // Keywords alone rank the hits.
      }
    }
    const scores = fuse([keyword, nearest]);
    const rows = new Map<number, Row>();
    for (const id of scores.keys()) {
      const r = this.row(id);
      if (r !== undefined) rows.set(id, r);
    }
    const hits = [...scores.entries()]
      .flatMap(([id, score]) => {
        const r = rows.get(id);
        return r === undefined ? [] : [{ r, score }];
      })
      // A verified entry wins a tie: the owner stands behind it.
      .sort((a, b) => b.score - a.score || b.r.verified - a.r.verified || a.r.id - b.r.id)
      .slice(0, input.limit)
      .map(({ r, score }) => {
        const entry = toEntry(r);
        const body =
          entry.body.length > HIT_BODY_MAX
            ? `${entry.body.slice(0, HIT_BODY_MAX)}\n[cut: kb.get has the rest]`
            : entry.body;
        return { entry: { ...entry, body }, score };
      });
    return { hits, keywordOnly };
  }

  /** Entries that have no vector yet (the model was not there), to fill in later. */
  async fillVectors(limit = 50): Promise<number> {
    const ids = this.db
      .prepare("SELECT id FROM kb_entries WHERE embedding IS NULL AND removed_at IS NULL LIMIT ?")
      .all(limit) as { id: number }[];
    for (const { id } of ids) await this.embedEntry(id);
    return ids.length;
  }
}
