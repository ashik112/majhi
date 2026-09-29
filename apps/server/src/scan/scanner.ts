import { stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import type { Repo, ReposResponse, ResolvedConfig, RootScan } from "@majhi/shared";
import { errorCode, errorMessage } from "../errors.ts";
import { readGitMeta } from "./gitMeta.ts";
import { describeRemote } from "./remote.ts";
import { loadSshConfig, type SshConfig } from "./sshConfig.ts";
import { createLimiter, findRepos, type Limiter } from "./walk.ts";

export const SCAN_DEPTH = 4;
const CONCURRENCY = 32;
/** How many unreadable folders a root lists by name before summing up the rest. */
const LISTED_ERRORS = 3;

export interface ScanRequest {
  config: ResolvedConfig;
  /** Absolute paths of projects registered in majhi.yaml. */
  projectPaths: readonly string[];
  /** Owner's home, for `~/.ssh/config`. */
  hostHome: string;
}

/** Scans every workspace root. Roots come back in config order, repos sorted by relPath. */
export async function scanWorkspaces(request: ScanRequest): Promise<ReposResponse> {
  const started = performance.now();
  const limit = createLimiter(CONCURRENCY);
  const ssh = await loadSshConfig(request.hostHome);
  const registered = new Set(request.projectPaths);
  const skip = new Set([request.config.tasksDir]);
  const roots = await Promise.all(
    request.config.workspaces.map((root) => scanRoot(root, { skip, limit, ssh, registered })),
  );
  return {
    roots,
    scannedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
  };
}

interface RootContext {
  skip: ReadonlySet<string>;
  limit: Limiter;
  ssh: SshConfig;
  registered: ReadonlySet<string>;
}

async function scanRoot(root: string, ctx: RootContext): Promise<RootScan> {
  try {
    if (!(await stat(root)).isDirectory()) {
      return { path: root, mounted: false, repos: [], error: "Not a folder" };
    }
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return { path: root, mounted: false, repos: [] };
    return { path: root, mounted: false, repos: [], error: errorMessage(err) };
  }

  const walk = await findRepos(root, { maxDepth: SCAN_DEPTH, skip: ctx.skip, limit: ctx.limit });
  const repos = await Promise.all(
    walk.repos.map(async (path): Promise<Repo> => {
      const meta = await ctx.limit(() => readGitMeta(path));
      const repo: Repo = {
        name: basename(path),
        path,
        relPath: relative(root, path) || ".",
        remotes: meta.remotes.map((r) => describeRemote(r.name, r.url, ctx.ssh)),
        registered: ctx.registered.has(path),
      };
      if (meta.branch !== undefined) repo.branch = meta.branch;
      return repo;
    }),
  );
  repos.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const scan: RootScan = { path: root, mounted: true, repos };
  if (walk.errors.length > 0) scan.error = describeErrors(walk.errors);
  return scan;
}

function describeErrors(errors: readonly string[]): string {
  const sorted = [...errors].sort();
  const listed = sorted.slice(0, LISTED_ERRORS).join(", ");
  const more = sorted.length - LISTED_ERRORS;
  const noun = sorted.length === 1 ? "folder" : "folders";
  return `Could not read ${sorted.length} ${noun}: ${listed}${more > 0 ? ` and ${more} more` : ""}`;
}

/**
 * Keeps the last scan in memory. A scan is reused until the config changes
 * or the caller asks for a refresh. Callers asking at the same time share one scan.
 */
export class RepoScanner {
  private last: { key: string; result: Promise<ReposResponse> } | undefined;

  scan(request: ScanRequest, refresh: boolean): Promise<ReposResponse> {
    const key = JSON.stringify([request.config, [...request.projectPaths].sort(), request.hostHome]);
    if (!refresh && this.last?.key === key) return this.last.result;
    const result = scanWorkspaces(request);
    const entry = { key, result };
    this.last = entry;
    // A failed scan is not worth keeping.
    result.catch(() => {
      if (this.last === entry) this.last = undefined;
    });
    return result;
  }
}
