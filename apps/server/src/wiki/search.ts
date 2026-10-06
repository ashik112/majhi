import type { WikiPage, WikiPageId } from "@majhi/shared";
import type Database from "better-sqlite3";
import { EMBEDDING_DIMS } from "../memory/migrations.ts";
import { CANDIDATES, fuse } from "../memory/search.ts";
import { ftsQuery, MIN_SIMILARITY } from "../memory/store.ts";
import type { PageIndex } from "./service.ts";

/** A piece of a page agents search: a paragraph of its text, or one claim with its status and citations. */
export interface Chunk {
  kind: "text" | "claim";
  /** The claim's number on its page. */
  n?: number | undefined;
  text: string;
  /** For a claim: `proven` or `guessed`, then where it is shown, as `path:start-end` lines. Empty for text. */
  detail: string;
}

export interface ChunkHit extends Chunk {
  org: string;
  /** Empty for a workspace page. */
  project: string;
  page: WikiPageId;
  score: number;
}

/** Paragraphs this short are joined to the next one, so a heading alone is never a hit. */
const MIN_CHUNK_CHARS = 200;
const MAX_CHUNK_CHARS = 900;

/** A page as pieces: its text in paragraphs (short ones joined, long ones cut), then each claim. */
export function chunksOf(page: WikiPage): Chunk[] {
  const out: Chunk[] = [];
  const pieces: string[] = [];
  let held = "";
  for (const paragraph of page.body.split("\n\n")) {
    const text = paragraph.trim();
    if (text === "") continue;
    held = held === "" ? text : `${held}\n\n${text}`;
    if (held.length >= MIN_CHUNK_CHARS) {
      pieces.push(held);
      held = "";
    }
  }
  if (held !== "") pieces.push(held);
  for (const piece of pieces) {
    for (let at = 0; at < piece.length; at += MAX_CHUNK_CHARS) {
      out.push({ kind: "text", text: piece.slice(at, at + MAX_CHUNK_CHARS), detail: "" });
    }
  }
  for (const c of page.claims) {
    const where = c.sources.map((s) => `${s.path}:${s.lines[0]}-${s.lines[1]}`).join(", ");
    out.push({
      kind: "claim",
      n: c.n,
      text: c.text,
      detail: `${c.proven ? "proven" : "guessed"}${where === "" ? "" : `: ${where}`}`,
    });
  }
  return out;
}

function vectorBytes(vector: Float32Array): Buffer {
  if (vector.length !== EMBEDDING_DIMS) {
    throw new Error(`An embedding has ${EMBEDDING_DIMS} numbers, not ${vector.length}.`);
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

const marks = (values: readonly unknown[]) => values.map(() => "?").join(", ");

interface ChunkRow {
  id: number;
  org: string;
  project: string;
  page: string;
  kind: "text" | "claim";
  n: number | null;
  text: string;
  detail: string;
}

/**
 * The wiki's pages as searchable pieces in `memory.db`: keywords (FTS5) and meaning (the local embedder), fused by
 * reciprocal rank like the lessons and task records. A workspace and its projects are named in every search, so
 * a hit never comes from another workspace.
 */
export class WikiIndex implements PageIndex {
  constructor(
    private readonly db: Database.Database,
    /** Unit vectors, or undefined when the model is not there: the keywords alone then rank the hits. */
    private readonly embed: (texts: readonly string[]) => Promise<Float32Array[] | undefined>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Replaces a page's pieces with the page as it is now. */
  async put(page: WikiPage): Promise<void> {
    const chunks = chunksOf(page);
    const project = page.project ?? "";
    const ids = this.db.transaction(() => {
      this.remove(page.org, project, page.id);
      const insert = this.db.prepare(
        "INSERT INTO wiki_chunks (org, project, page, kind, n, text, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const fts = this.db.prepare("INSERT INTO wiki_chunks_fts (rowid, text) VALUES (?, ?)");
      return chunks.map((c) => {
        const id = Number(
          insert.run(page.org, project, page.id, c.kind, c.n ?? null, c.text, c.detail, this.now())
            .lastInsertRowid,
        );
        // A bigint rowid: better-sqlite3 binds a plain number as a float, which the FTS table refuses.
        fts.run(BigInt(id), c.text);
        return id;
      });
    })();
    const vectors = await this.embed(chunks.map((c) => c.text));
    if (vectors === undefined) return;
    const put = this.db.prepare("INSERT INTO wiki_chunks_vec (rowid, embedding) VALUES (?, ?)");
    this.db.transaction(() => {
      ids.forEach((id, i) => {
        const v = vectors[i];
        // The page may have been written again while the vectors were made: only rows that are still there get one.
        if (
          v !== undefined &&
          this.db.prepare("SELECT 1 FROM wiki_chunks WHERE id = ?").get(id) !== undefined
        ) {
          put.run(BigInt(id), vectorBytes(v));
        }
      });
    })();
  }

  drop(org: string, project: string | undefined, id: WikiPageId): void {
    this.db.transaction(() => this.remove(org, project ?? "", id))();
  }

  private remove(org: string, project: string, page: string): void {
    const rows = this.db
      .prepare("SELECT id FROM wiki_chunks WHERE org = ? AND project = ? AND page = ?")
      .all(org, project, page) as { id: number }[];
    for (const { id } of rows) {
      this.db.prepare("DELETE FROM wiki_chunks_fts WHERE rowid = ?").run(BigInt(id));
      this.db.prepare("DELETE FROM wiki_chunks_vec WHERE rowid = ?").run(BigInt(id));
    }
    this.db
      .prepare("DELETE FROM wiki_chunks WHERE org = ? AND project = ? AND page = ?")
      .run(org, project, page);
  }

  /** The best pieces for the words among one workspace's projects (`""` is the workspace's own pages), best first. */
  async search(input: {
    org: string;
    projects: readonly string[];
    query: string;
    kind?: "text" | "claim" | undefined;
    limit?: number | undefined;
  }): Promise<ChunkHit[]> {
    if (input.projects.length === 0) return [];
    const scope = `c.org = ? AND c.project IN (${marks(input.projects)})${input.kind === undefined ? "" : " AND c.kind = ?"}`;
    const params = [input.org, ...input.projects, ...(input.kind === undefined ? [] : [input.kind])];
    const words = ftsQuery(input.query);
    const keyword =
      words === undefined
        ? []
        : (
            this.db
              .prepare(
                `SELECT c.id AS id FROM wiki_chunks_fts JOIN wiki_chunks c ON c.id = wiki_chunks_fts.rowid
                 WHERE wiki_chunks_fts MATCH ? AND ${scope} ORDER BY bm25(wiki_chunks_fts) LIMIT ?`,
              )
              .all(words, ...params, CANDIDATES) as { id: number }[]
          ).map((r) => r.id);
    let nearest: number[] = [];
    const [vector] = (await this.embed([input.query])) ?? [];
    if (vector !== undefined) {
      nearest = (
        this.db
          .prepare(
            `SELECT rowid AS id, distance FROM wiki_chunks_vec
             WHERE embedding MATCH ? AND k = ? AND rowid IN (SELECT c.id FROM wiki_chunks c WHERE ${scope})
             ORDER BY distance`,
          )
          .all(vectorBytes(vector), CANDIDATES, ...params) as { id: number | bigint; distance: number }[]
      )
        .filter((r) => 1 - (r.distance * r.distance) / 2 >= MIN_SIMILARITY)
        .map((r) => Number(r.id));
    }
    const scores = fuse([keyword, nearest]);
    const ids = [...scores.keys()];
    if (ids.length === 0) return [];
    const rows = new Map(
      (
        this.db.prepare(`SELECT * FROM wiki_chunks WHERE id IN (${marks(ids)})`).all(...ids) as ChunkRow[]
      ).map((r) => [r.id, r]),
    );
    return [...scores.entries()]
      .flatMap(([id, score]) => {
        const r = rows.get(id);
        if (r === undefined) return [];
        const hit: ChunkHit = {
          org: r.org,
          project: r.project,
          page: r.page as WikiPageId,
          kind: r.kind,
          n: r.n ?? undefined,
          text: r.text,
          detail: r.detail,
          score,
        };
        return [hit];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit ?? 5);
  }
}
