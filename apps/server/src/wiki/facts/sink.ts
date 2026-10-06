import { createHash } from "node:crypto";
import {
  type CommitSha,
  ContentHashSchema,
  RepoPathSchema,
  type WikiFact,
  type WikiFactId,
  WikiFactIdSchema,
  type WikiFactKind,
  WikiFactSchema,
  type WikiSource,
} from "@majhi/shared";
import type { ProjectFiles } from "./files.ts";

/** A place in a file a scanner points at, before it is read: the path is checked and the lines are hashed when facts are built. */
export interface Cite {
  path: string;
  /** `[start, end]`, 1-based, inclusive. */
  lines: [number, number];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A fact as a scanner found it: everything but the id, the repo and the sources. The id is made from the kind and
 * the `slug`; the sources are made from the `cites`, read from the export. A fact with no readable cite is dropped,
 * because a fact without evidence is not a fact.
 */
export type Draft = DistributiveOmit<WikiFact, "id" | "repo" | "sources"> & {
  slug: string;
  cites: Cite[];
};

/** The most sources a fact keeps (the contract allows 12). */
const SOURCES_MAX = 12;
const SLUG_MAX = 140;
const SLUG_OK = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/@#-";

/**
 * The slug a fact id carries: the text itself when every character is allowed, else the allowed characters
 * with `_` for the rest and a short hash of the original, so two different texts never share an id.
 */
export function slugOf(text: string): string {
  let clean = "";
  for (const ch of text) clean += SLUG_OK.includes(ch) ? ch : "_";
  if (clean === text && clean.length <= SLUG_MAX) return clean;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return `${clean.slice(0, SLUG_MAX - 9)}#${hash}`;
}

/** Lines of a file as `[start, end]` cites count them: split at `\n`, a final newline ends the last line, `\r` is not part of a line. */
export function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** The hash a source stores for its lines: SHA-256 of the lines joined with `\n`. The checker computes it the same way. */
export function hashLines(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Turns cites into sources by reading the export. Every read stays inside the export (`ProjectFiles` refuses a
 * symlink out of it, a folder, a file that is too big and a path with `..`). A file is read once per run.
 */
export class Cites {
  private readonly texts = new Map<string, Promise<string[] | undefined>>();

  constructor(
    private readonly files: ProjectFiles,
    private readonly repo: string,
    private readonly commit: CommitSha,
  ) {}

  private lines(path: string): Promise<string[] | undefined> {
    let got = this.texts.get(path);
    if (got === undefined) {
      got = RepoPathSchema.safeParse(path).success
        ? this.files.read(path).then((text) => (text === undefined ? undefined : linesOf(text)))
        : Promise.resolve(undefined);
      this.texts.set(path, got);
    }
    return got;
  }

  /** The source of the cited lines, or undefined when the path is not a readable file inside the export or the lines are outside it. */
  async source(cite: Cite): Promise<WikiSource | undefined> {
    const all = await this.lines(cite.path);
    if (all === undefined) return undefined;
    const [start, wanted] = cite.lines;
    if (start < 1 || wanted < start || start > all.length) return undefined;
    const end = Math.min(wanted, all.length);
    return {
      repo: this.repo,
      commit: this.commit,
      path: cite.path,
      lines: [start, end],
      hash: ContentHashSchema.parse(hashLines(all.slice(start - 1, end))),
    };
  }
}

export type DropReason = "no-source" | "invalid";

export interface Built {
  facts: WikiFact[];
  dropped: Record<DropReason, number>;
}

type Held = Draft & { id: WikiFactId };

function union<T>(a: readonly T[], b: readonly T[]): T[] {
  return [...new Set([...a, ...b])];
}

/** Two drafts with one id are one fact that two files show: keep what the first knew, fill in what only the second did. */
function merged(a: Held, b: Draft): Held {
  const cites = [...a.cites];
  for (const c of b.cites) {
    if (!cites.some((x) => x.path === c.path && x.lines[0] === c.lines[0])) cites.push(c);
  }
  const base = { ...a, cites };
  if (a.kind === "unit" && b.kind === "unit") {
    return {
      ...base,
      kind: "unit",
      role: a.role !== "unknown" ? a.role : b.role,
      image: a.image ?? b.image,
      runsOn: a.runsOn ?? b.runsOn,
      ports: union(a.ports, b.ports),
      dependsOn: union(a.dependsOn, b.dependsOn),
    } as Held;
  }
  if (a.kind === "store" && b.kind === "store") {
    return { ...base, kind: "store", unit: a.unit ?? b.unit } as Held;
  }
  if (a.kind === "endpoint" && b.kind === "endpoint") {
    return { ...base, kind: "endpoint", keys: union(a.keys, b.keys).slice(0, 12) } as Held;
  }
  return base;
}

/** What the scanners found. The same fact found twice (two compose files, a manifest and an env file) is one fact with all its cites. */
export class FactSink {
  private readonly held = new Map<string, Held>();

  constructor(readonly repo: string) {}

  add(draft: Draft): void {
    const id = this.idOf(draft.kind, draft.slug);
    const had = this.held.get(id);
    this.held.set(id, had === undefined ? { ...draft, id } : merged(had, draft));
  }

  /** The id a fact of this kind and slug gets, for a fact that points at another (a link). */
  idOf(kind: WikiFactKind, slug: string): WikiFactId {
    return WikiFactIdSchema.parse(`${this.repo}:${kind}:${slugOf(slug)}`);
  }

  /** Reads every cite, drops a fact with none, checks the rest against the contract. Sorted by id: the same export gives the same file. */
  async build(cites: Cites): Promise<Built> {
    const dropped: Record<DropReason, number> = { "no-source": 0, invalid: 0 };
    const facts: WikiFact[] = [];
    for (const draft of [...this.held.values()].toSorted((a, b) => a.id.localeCompare(b.id))) {
      const sources: WikiSource[] = [];
      for (const cite of draft.cites) {
        if (sources.length >= SOURCES_MAX) break;
        const got = await cites.source(cite);
        if (got !== undefined) sources.push(got);
      }
      if (sources.length === 0) {
        dropped["no-source"] += 1;
        continue;
      }
      const { slug: _slug, cites: _cites, ...fact } = draft;
      const parsed = WikiFactSchema.safeParse({ ...fact, id: draft.id, repo: this.repo, sources });
      if (parsed.success) facts.push(parsed.data);
      else dropped.invalid += 1;
    }
    return { facts, dropped };
  }
}
