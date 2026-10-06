import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommitSha,
  WIKI_FACT_KINDS,
  WIKI_RULES,
  type WikiFactKind,
  type WikiFactsFile,
  WikiFactsFileSchema,
} from "@majhi/shared";
import { UserError } from "../../errors.ts";
import type { FactsReader } from "../../reader/run.ts";
import { buildContext } from "./context.ts";
import { ProjectFiles } from "./files.ts";
import { readRepo } from "./read.ts";
import { parseReaderOutput } from "./reader-output.ts";
import { addReaderFacts } from "./scan-reader.ts";
import { Cites, type DropReason, FactSink } from "./sink.ts";
import { FACT_SOURCES } from "./sources.ts";

/** What one fact run leaves in the cache folder: the reader's findings, and the facts made from them. */
export const FACTS_FILE = "facts.json";
export const READER_FILE = "reader.json";

export interface ExtractInput {
  /** The workspace and project the facts are for. */
  org: string;
  project: string;
  /** The clean export of the commit (`exportCommit`): the only place files are read from. */
  exportDir: string;
  /** The project's wiki cache folder (`wikiCacheDir`): the sealed reader writes here, and `facts.json` goes here. */
  cacheDir: string;
  sha: CommitSha;
}

/** What a run says about itself, for the update's log and the Gaps page: nothing here is a fact. */
export interface FactsReport {
  ms: number;
  /** Source files the entry pass read. */
  files: number;
  counts: Record<WikiFactKind, number>;
  /** Routes folded into another (the same route under two mounts, one route listed for every method). */
  folded: number;
  /** Facts left out: no cited file could be read inside the export, or the fact did not fit the contract. */
  dropped: Record<DropReason, number>;
  /** What a reader tool said when it failed (Noir not finding its way, a file the grammars choked on). Facts from the other tools stand. */
  errors: string[];
}

export interface ExtractResult {
  file: WikiFactsFile;
  report: FactsReport;
}

/**
 * The facts of one repo at one commit, with no model: the sealed reader reads the export (routes, queue consumers,
 * timers, commands, sockets, calls), the scanners read its config files (compose, Kubernetes, manifests, example
 * environment files, deploy files) from every folder, and everything becomes a typed `WikiFact` with the lines that
 * show it (`path`, `lines`, and the SHA-256 of those lines). Writes `facts.json` in the cache folder and returns it.
 *
 * Only names, paths and line numbers are kept. An environment or compose value is read for its host and its setting
 * name, and never reaches a fact. A path that leaves the export, or a symlink out of it, cites nothing, and a fact
 * with no citation is dropped.
 *
 * Throws when the reader itself does not run (no container): a repo with no facts must not look like a repo with an
 * empty wiki.
 */
export async function extractFacts(input: ExtractInput, reader: FactsReader): Promise<ExtractResult> {
  const started = Date.now();
  const files = new ProjectFiles(input.exportDir);
  if (!(await files.exists(""))) throw new UserError(`The export of ${input.project} is not there.`);

  const run = await reader.readFacts(input.exportDir, input.cacheDir);
  if (!run.ok) throw new UserError(`Reading ${input.project} failed: ${run.reason}`);
  const out = parseReaderOutput(await readFile(join(input.cacheDir, READER_FILE), "utf8"));

  const sink = new FactSink(input.project);
  const scan = await readRepo(files, input.project);
  const ctx = buildContext(scan, sink);
  for (const source of FACT_SOURCES) source.scan(ctx);
  const { folded } = addReaderFacts(sink, out);

  const built = await sink.build(new Cites(files, input.project, input.sha));
  const file = WikiFactsFileSchema.parse({
    repo: input.project,
    commit: input.sha,
    rules: WIKI_RULES,
    facts: built.facts,
  });
  await mkdir(input.cacheDir, { recursive: true, mode: 0o700 });
  const tmp = join(input.cacheDir, `${FACTS_FILE}.tmp`);
  await writeFile(tmp, JSON.stringify(file));
  await rename(tmp, join(input.cacheDir, FACTS_FILE));

  const counts = Object.fromEntries(WIKI_FACT_KINDS.map((k) => [k, 0])) as Record<WikiFactKind, number>;
  for (const f of file.facts) counts[f.kind] += 1;
  return {
    file,
    report: {
      ms: Date.now() - started,
      files: out.files,
      counts,
      folded,
      dropped: built.dropped,
      errors: out.errors,
    },
  };
}
