import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BaseEnv, Spawner } from "@majhi/acp";
import { OrgIdSchema } from "@majhi/shared";
import { errorMessage } from "../../errors.ts";

/** The graphify release the runner image installs. Raise it in the Dockerfile and here together. */
export const GRAPHIFY_VERSION = "0.9.77";

/** Where the runner image keeps the reader (`docker/map-extract.py`) and the Python that has graphify. */
export const EXTRACT_COMMAND = {
  command: "/opt/graphify/bin/python",
  args: ["/usr/local/lib/majhi/map-extract.py"],
} as const;

/** The most one project may take, and the memory its reader gets. */
const TIMEOUT_MS = 10 * 60_000;
const MEMORY = "2g";
const MAX_OUTPUT = 16 * 1024;

/** A folder name made from a project id: one path segment, never a way out of the map folder. */
export function segment(id: string): string | undefined {
  const bad = id === "" || id === "." || id === ".." || id.length > 120;
  if (bad || id.includes("/") || id.includes("\\") || id.includes("\0")) return undefined;
  return id;
}

/**
 * Where a project's code graph is kept: `<tasks folder>/.map/<workspace>/<project>`. One folder per
 * project, so graphify's own cache and manifest in it make the next read incremental. Null for an id that
 * is not a safe folder name.
 */
export function graphFolder(root: string, org: string, project: string): string | null {
  const o = OrgIdSchema.safeParse(org);
  const p = segment(project);
  return o.success && p !== undefined ? join(root, o.data, p) : null;
}

export interface GraphRunDeps {
  /** Starts programs in a runner container. A local spawner refuses an isolated run. */
  spawner: Spawner;
  /** PATH and LANG of runs. Never majhi's own environment. */
  base: BaseEnv;
  /** The map folder in the tasks folder: runners can mount it, and it is never inside majhi's config folder. */
  root: () => Promise<string>;
  timeoutMs?: number;
}

export type GraphRun = { ok: true; folder: string; ms: number } | { ok: false; reason: string };

/**
 * Reads one project with graphify (SPEC 5.21), in a throwaway runner container with no network at all, the
 * project mounted read-only and the project's map folder the only place it can write. No model is used.
 */
export class GraphRunner {
  constructor(private readonly deps: GraphRunDeps) {}

  /** The folder of a project's graph, or null for an unsafe id. */
  async folder(org: string, project: string): Promise<string | null> {
    return graphFolder(await this.deps.root(), org, project);
  }

  /** Removes a project's graph. */
  async forget(org: string, project: string): Promise<void> {
    const folder = await this.folder(org, project);
    if (folder !== null) await rm(folder, { recursive: true, force: true });
  }

  async extract(org: string, project: string, path: string): Promise<GraphRun> {
    const folder = await this.folder(org, project);
    if (folder === null) return { ok: false, reason: `"${project}" is not a usable folder name.` };
    const started = Date.now();
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const { code, output } = await this.run(path, folder);
      if (code === 0) return { ok: true, folder, ms: Date.now() - started };
      return { ok: false, reason: tail(output) };
    } catch (err) {
      return { ok: false, reason: errorMessage(err) };
    }
  }

  private run(project: string, folder: string): Promise<{ code: number | null; output: string }> {
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
      const limit = this.deps.timeoutMs ?? TIMEOUT_MS;
      const timer = setTimeout(() => {
        kill();
        output += `\nStopped after ${Math.round(limit / 1000)} s.`;
        finish(null);
      }, limit);
      this.deps
        .spawner({
          command: { command: EXTRACT_COMMAND.command, args: [...EXTRACT_COMMAND.args, project, folder] },
          env,
          cwd: folder,
          scratch: true,
          isolated: true,
          mounts: [{ path: project, readOnly: true }, { path: folder }],
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
