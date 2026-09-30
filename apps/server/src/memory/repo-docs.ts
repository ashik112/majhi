import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { cosine } from "./embedder.ts";

/** The files whose rules a lesson must never restate. */
export const RULE_DOCS = ["CLAUDE.md", "AGENTS.md", "README.md"] as const;
/** Files whose headings describe a project, for its first brief. */
export const OVERVIEW_DOCS = ["README.md", "SPEC.md", "AGENTS.md", "CLAUDE.md", "docs/PROGRESS.md"] as const;

/** A lesson this close in meaning to a chunk of the repo docs says what they already say. */
export const LESSON_DOC_COSINE = 0.8;
/** Stricter, for the one-time cleanup of old facts: only near-identical ones go. */
export const CLEANUP_DOC_COSINE = 0.88;
/** Or this share of its words is in one chunk. */
export const DOC_WORD_SHARE = 0.85;

const MAX_DOC_BYTES = 200_000;
const MAX_CHUNK = 600;

const STOP = new Set(
  "a an and are as at be by do does for from has have in is it its not of on or so that the this to use used uses with you your we our they them must never always should".split(
    " ",
  ),
);

/** The content words of a text, lowercased. */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []).filter(
    (w) => w.length > 1 && !STOP.has(w),
  );
}

/** How much of `text`'s content words are in `chunk`, 0 to 1. A text of fewer than 3 words scores 0. */
export function wordShare(text: string, chunk: string): number {
  const words = [...new Set(contentWords(text))];
  if (words.length < 3) return 0;
  const inChunk = new Set(contentWords(chunk));
  return words.filter((w) => inChunk.has(w)).length / words.length;
}

/**
 * Markdown cut into the pieces a rule lives in: each bullet or numbered line (with its wrapped
 * lines), and each paragraph. Headings, code fences and very short pieces are left out.
 */
export function chunkDoc(markdown: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let fence = false;
  const flush = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    current = [];
    if (text.length >= 12) chunks.push(text.slice(0, MAX_CHUNK));
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (line.trim() === "" || /^\s*#/.test(line)) {
      flush();
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      current.push(line.replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      continue;
    }
    current.push(line.trim());
  }
  flush();
  return chunks;
}

/** The markdown headings of a file, as an outline. */
export function headings(markdown: string, max = 40): string[] {
  let fence = false;
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^#{1,4}\s+\S/.test(line)) out.push(line.trim());
    if (out.length >= max) break;
  }
  return out;
}

export interface DocChunk {
  file: string;
  text: string;
  vector?: Float32Array | undefined;
}

export interface RepoDocsDeps {
  /** Unit vectors for the texts, or undefined when the model is not there. */
  embed: (texts: readonly string[]) => Promise<Float32Array[] | undefined>;
}

/** A file under a repo, read when it is a regular file of sensible size. */
export async function readRepoFile(repo: string, file: string): Promise<string | undefined> {
  try {
    const path = join(repo, file);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_DOC_BYTES) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The rules a repo already writes down (CLAUDE.md, AGENTS.md, README), cut into chunks with their
 * vectors, cached per file until it changes.
 */
export class RepoDocs {
  private readonly cache = new Map<string, { key: string; chunks: DocChunk[] }>();

  constructor(private readonly deps: RepoDocsDeps) {}

  /** The chunks of the rule docs of these repo folders. */
  async chunks(repos: readonly string[]): Promise<DocChunk[]> {
    const out: DocChunk[] = [];
    for (const repo of new Set(repos)) {
      for (const file of RULE_DOCS) out.push(...(await this.fileChunks(repo, file)));
    }
    return out;
  }

  /** The rule docs as text, for a prompt, cut to `maxChars`. */
  async text(repos: readonly string[], maxChars: number): Promise<string> {
    const parts: string[] = [];
    for (const repo of new Set(repos)) {
      for (const file of RULE_DOCS) {
        const text = await readRepoFile(repo, file);
        if (text !== undefined && text.trim() !== "") parts.push(`--- ${file} ---\n${text.trim()}`);
      }
    }
    const all = parts.join("\n\n");
    return all.length > maxChars ? `${all.slice(0, maxChars)}\n[cut]` : all;
  }

  /**
   * The chunk that already says `text`: its vector is at least `minCosine` close, or it holds
   * `DOC_WORD_SHARE` of the text's words. Undefined when none does.
   */
  async match(
    text: string,
    chunks: readonly DocChunk[],
    minCosine: number,
  ): Promise<{ chunk: DocChunk; similarity: number } | undefined> {
    if (chunks.length === 0) return undefined;
    let best: { chunk: DocChunk; similarity: number } | undefined;
    for (const chunk of chunks) {
      const share = wordShare(text, chunk.text);
      if (share >= DOC_WORD_SHARE && (best === undefined || share > best.similarity))
        best = { chunk, similarity: share };
    }
    if (best !== undefined) return best;
    const [vector] = (await this.deps.embed([text])) ?? [];
    if (vector === undefined) return undefined;
    for (const chunk of chunks) {
      if (chunk.vector === undefined) continue;
      const c = cosine(vector, chunk.vector);
      if (c >= minCosine && (best === undefined || c > best.similarity)) best = { chunk, similarity: c };
    }
    return best;
  }

  private async fileChunks(repo: string, file: string): Promise<DocChunk[]> {
    const path = join(repo, file);
    let key: string;
    try {
      const info = await stat(path);
      if (!info.isFile()) return [];
      key = `${info.mtimeMs}:${info.size}`;
    } catch {
      return [];
    }
    const cached = this.cache.get(path);
    if (cached !== undefined && cached.key === key && cached.chunks.every((c) => c.vector !== undefined)) {
      return cached.chunks;
    }
    const text = await readRepoFile(repo, file);
    if (text === undefined) return [];
    const pieces = chunkDoc(text);
    const vectors = pieces.length === 0 ? [] : await this.deps.embed(pieces);
    const chunks = pieces.map((t, i) => ({ file, text: t, vector: vectors?.[i] }));
    this.cache.set(path, { key, chunks });
    return chunks;
  }
}
