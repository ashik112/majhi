import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommitSha,
  type WikiAnswer,
  type WikiFact,
  type WikiFactsFile,
  WikiFactsFileSchema,
  type WikiSystemView,
} from "@majhi/shared";
import { FACTS_FILE } from "../facts/extract.ts";
import { buildSystem } from "./links.ts";

/** What the system step reads. Everything is for one workspace: it never asks for another's. */
export interface SystemSources {
  /** The workspace's projects on this computer, with the projects each declares it depends on. */
  projects: (org: string) => Promise<readonly { id: string; declared: readonly string[] }[]>;
  /** The facts of a project at the commit it was last read, or undefined when it never was. */
  facts: (org: string, project: string) => Promise<WikiFactsFile | undefined>;
  answers: (org: string) => readonly WikiAnswer[];
}

export interface LoadedSystem {
  view: WikiSystemView;
  /** The commit each project's facts were read at: what a workspace page built from them is built from. */
  commits: Record<string, CommitSha>;
  /** Every project's facts, for what must tell whether a fact is still in the code. */
  facts: readonly WikiFact[];
}

/**
 * The workspace's links, drawn from the stored facts of its own projects and its own answers, with no model and no
 * reader. A project of another workspace is never read, and a declared link to one is dropped.
 */
export async function loadSystem(org: string, sources: SystemSources): Promise<LoadedSystem> {
  const members = await sources.projects(org);
  const read = await Promise.all(members.map(async (m) => ({ m, file: await sources.facts(org, m.id) })));
  const withFacts = read.flatMap(({ m, file }) => (file === undefined ? [] : [{ m, file }]));
  const view = buildSystem({
    org,
    projects: withFacts.map(({ m, file }) => ({ id: m.id, facts: file.facts, declared: m.declared })),
    answers: sources.answers(org),
    missing: read.filter(({ file }) => file === undefined).map(({ m }) => m.id),
  });
  return {
    view,
    commits: Object.fromEntries(withFacts.map(({ m, file }) => [m.id, file.commit])),
    facts: withFacts.flatMap(({ file }) => file.facts),
  };
}

/** The last facts file read of each cache folder, with the size and time that file had: a file that did not change is not parsed again. */
const parsed = new Map<string, { key: string; file: WikiFactsFile }>();

/** The facts file a project's last run left in its cache folder. A file that is missing or does not parse reads as never read. */
export async function readFactsFile(cacheDir: string): Promise<WikiFactsFile | undefined> {
  const path = join(cacheDir, FACTS_FILE);
  try {
    const info = await stat(path);
    const key = `${info.size}:${info.mtimeMs}`;
    const had = parsed.get(path);
    if (had?.key === key) return had.file;
    const file = WikiFactsFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!file.success) return undefined;
    parsed.set(path, { key, file: file.data });
    return file.data;
  } catch {
    return undefined;
  }
}
