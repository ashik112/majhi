import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { RootSuggestion } from "@majhi/shared";

/** Levels below a candidate to look for repos, as the server's scanner does. The candidate is level 0. */
export const SUGGEST_DEPTH = 4;
export const MAX_SUGGESTIONS = 6;
export const DEFAULT_BUDGET: SuggestBudget = { ms: 2_000, dirs: 20_000 };
const CONCURRENCY = 32;

export interface SuggestBudget {
  /** Stop counting after this long and return what was counted. */
  ms: number;
  /** Stop after reading this many folders. */
  dirs: number;
}

/**
 * Suggests workspace roots: first-level folders of home that hold git repos,
 * with how many, most first. Counting follows the server scanner's rules (no
 * hidden folders, no `node_modules`, no symlinks, nothing inside a repo) and
 * stops at the budget. `skippedAtHome` are the OS's folders that never hold
 * projects (`folders.skippedAtHome`).
 */
export async function suggestRoots(
  home: string,
  skippedAtHome: ReadonlySet<string>,
  budget: SuggestBudget = DEFAULT_BUDGET,
): Promise<RootSuggestion[]> {
  const base = await realpath(home).catch(() => home);
  const top = await readdir(base, { withFileTypes: true });
  const candidates = top
    .filter((e) => e.isDirectory() && !skipped(e) && !skippedAtHome.has(e.name))
    .map((e) => join(base, e.name));

  const counts = new Map(candidates.map((c) => [c, 0]));
  const state = { stopped: false, read: 0 };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budget.ms);
  });

  // Breadth-first across every candidate at once, so one huge folder cannot use up the
  // budget before the others are looked at.
  const walk = async (): Promise<void> => {
    let level = candidates.map((root) => ({ root, dir: root, depth: 0 }));
    while (level.length > 0 && !state.stopped) {
      const next = await mapLimited(level, CONCURRENCY, async (item) => {
        if (state.stopped || state.read >= budget.dirs) return [];
        state.read++;
        const entries = await readdir(item.dir, { withFileTypes: true }).catch(() => []);
        const git = entries.find((e) => e.name === ".git");
        if (git !== undefined) {
          if (git.isDirectory() && !state.stopped) counts.set(item.root, (counts.get(item.root) ?? 0) + 1);
          return [];
        }
        if (item.depth >= SUGGEST_DEPTH) return [];
        return entries
          .filter((e) => e.isDirectory() && !skipped(e))
          .map((e) => ({ root: item.root, dir: join(item.dir, e.name), depth: item.depth + 1 }));
      });
      level = next.flat();
    }
  };

  await Promise.race([walk(), deadline]);
  state.stopped = true;
  clearTimeout(timer);

  return [...counts]
    .filter(([, repoCount]) => repoCount > 0)
    .map(([path, repoCount]) => ({ path, repoCount }))
    .sort((a, b) => b.repoCount - a.repoCount || (a.path < b.path ? -1 : 1))
    .slice(0, MAX_SUGGESTIONS);
}

/** Hidden folders and `node_modules` are never scanned, as in the server's scanner. */
function skipped(entry: Dirent): boolean {
  return entry.name.startsWith(".") || entry.name === "node_modules";
}

/** Runs `task` over `items` with at most `limit` running at once, results in order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // One iterator shared by every worker, so each item is taken once.
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) results[index] = await task(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
