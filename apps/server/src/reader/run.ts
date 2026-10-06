import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BaseEnv, Spawner } from "@majhi/acp";
import { OrgIdSchema } from "@majhi/shared";
import { errorMessage } from "../errors.ts";

/** The graphify release the runner image installs. Raise it in the Dockerfile and here together. */
export const GRAPHIFY_VERSION = "0.9.77";

/** The Noir release the runner image installs. Raise it in the Dockerfile and here together. */
export const NOIR_VERSION = "1.4.0";

/** Where the runner image keeps the wiki's reader (`docker/wiki_facts.py`) and the Python that has graphify and tree-sitter. */
export const READER_COMMAND = {
  command: "/opt/graphify/bin/python",
  args: ["/usr/local/lib/majhi/wiki_facts.py"],
} as const;

/** The most one repo may take, and the memory its reader gets. The facts pass is seconds; the first graph is about a minute. */
const FACTS_TIMEOUT_MS = 5 * 60_000;
const GRAPH_TIMEOUT_MS = 15 * 60_000;
const MEMORY = "4g";
const MAX_OUTPUT = 16 * 1024;

/** A folder name made from a project id: one path segment, never a way out of the wiki folder. */
export function segment(id: string): string | undefined {
  const bad = id === "" || id === "." || id === ".." || id.length > 120;
  if (bad || id.includes("/") || id.includes("\\") || id.includes("\0")) return undefined;
  return id;
}

/**
 * Where a project's code graph is kept: `<root>/<workspace>/<project>/graph`, where `root` is the wiki folder in the
 * tasks folder (`<tasks folder>/.wiki`) and the rest is the project's wiki cache folder (`wikiCacheDir`), so graphify's own cache and manifest make the next update incremental. Null for an id that is
 * not a safe folder name.
 */
export function graphFolder(root: string, org: string, project: string): string | null {
  const o = OrgIdSchema.safeParse(org);
  const p = segment(project);
  return o.success && p !== undefined ? join(root, o.data, p, "graph") : null;
}

export interface GraphRunDeps {
  /** Starts programs in a runner container. A local spawner refuses an isolated run. */
  spawner: Spawner;
  /** PATH and LANG of runs. Never majhi's own environment. */
  base: BaseEnv;
  timeoutMs?: number;
}

export type ReaderRun = { ok: true; ms: number } | { ok: false; reason: string };

/** What a repo's facts need from the sealed reader: the export read, and the code graph updated. */
export interface FactsReader {
  /** Writes `reader.json` in the cache folder: routes, queue consumers, timers, commands, sockets and calls. */
  readFacts(exportDir: string, cacheDir: string): Promise<ReaderRun>;
}

/**
 * The sealed reader (docs/design/wiki.md, step 1): one throwaway runner container per run, with no network at all, the
 * repo's clean export mounted read-only and its cache folder the only place it can write. No model is used. The
 * facts pass (`readFacts`) takes seconds; the code graph (`updateGraph`) is graphify's incremental update, a minute
 * the first time and seconds after, and `code_graph` reads its `graph.json`.
 */
export class GraphRunner implements FactsReader {
  constructor(private readonly deps: GraphRunDeps) {}

  readFacts(exportDir: string, cacheDir: string): Promise<ReaderRun> {
    return this.run(exportDir, cacheDir, [], this.deps.timeoutMs ?? FACTS_TIMEOUT_MS);
  }

  updateGraph(exportDir: string, cacheDir: string): Promise<ReaderRun> {
    return this.run(exportDir, cacheDir, ["--graph"], this.deps.timeoutMs ?? GRAPH_TIMEOUT_MS);
  }

  private async run(exportDir: string, cacheDir: string, flags: string[], limit: number): Promise<ReaderRun> {
    const started = Date.now();
    try {
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      const { code, output } = await this.spawn(exportDir, cacheDir, flags, limit);
      return code === 0 ? { ok: true, ms: Date.now() - started } : { ok: false, reason: tail(output) };
    } catch (err) {
      return { ok: false, reason: errorMessage(err) };
    }
  }

  private spawn(
    exportDir: string,
    cacheDir: string,
    flags: string[],
    limit: number,
  ): Promise<{ code: number | null; output: string }> {
    const { base } = this.deps;
    const env: Record<string, string> = {
      PATH: base.PATH,
      HOME: "/tmp",
      GRAPHIFY_NO_AUTO_REFRESH: "1",
      DO_NOT_TRACK: "1",
      NO_COLOR: "1",
      ...(base.LANG ? { LANG: base.LANG } : {}),
    };
    return new Promise((resolve) => {
      let output = "";
      let done = false;
      let kill = () => {};
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, output });
      };
      const timer = setTimeout(() => {
        kill();
        output += `\nStopped after ${Math.round(limit / 1000)} s.`;
        finish(null);
      }, limit);
      this.deps
        .spawner({
          command: {
            command: READER_COMMAND.command,
            args: [...READER_COMMAND.args, exportDir, cacheDir, ...flags],
          },
          env,
          cwd: cacheDir,
          scratch: true,
          isolated: true,
          mounts: [{ path: exportDir, readOnly: true }, { path: cacheDir }],
          limits: { cpus: "1", memory: MEMORY, cpuShares: "256" },
        })
        .then(
          (spawned) => {
            kill = spawned.kill;
            const { child } = spawned;
            const take = (c: Buffer) => {
              if (output.length < MAX_OUTPUT) output += c.toString();
            };
            child.stdout.on("data", take);
            child.stderr.on("data", take);
            child.stdin.end();
            child.once("error", (err) => {
              output += errorMessage(err);
              finish(null);
            });
            child.once("close", (code) => finish(code));
          },
          (err) => {
            output += errorMessage(err);
            finish(null);
          },
        );
    });
  }
}

/** The last lines of output, short enough for a report note. */
function tail(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const last = lines.slice(-3).join(" ");
  return last.length > 300 ? `${last.slice(0, 299)}…` : last || "no output";
}
