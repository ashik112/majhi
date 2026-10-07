import { type CiCheck, ciChecks } from "./jobs.ts";
import { type CiSource, readCiFiles } from "./read.ts";

/**
 * The one reader of the checks a repo's CI runs. The project page, the project card's commands and the
 * hand-off check all read them here. A read of a folder is kept for a short while (`TTL_MS`), so a page
 * that asks again does not parse every workflow again, and a change to a CI file shows up on its own.
 */
const TTL_MS = 60_000;
const MAX_KEPT = 200;
const kept = new Map<string, { at: number; value: Promise<CiCheck[]> }>();

/** For tests. */
export function forgetCiChecks(): void {
  kept.clear();
}

/**
 * The checks of the CI files in `files`. `key` (the folder they are read from) turns the cache on; a
 * hand-off check of a task's own commit passes `fresh` to read the files as they are now.
 */
export function readCiChecks(
  files: CiSource,
  opts: { key?: string; fresh?: boolean; now?: number } = {},
): Promise<CiCheck[]> {
  const now = opts.now ?? Date.now();
  const { key } = opts;
  if (key !== undefined && opts.fresh !== true) {
    const hit = kept.get(key);
    if (hit !== undefined && now - hit.at < TTL_MS) return hit.value;
  }
  const value = readCiFiles(files).then(ciChecks);
  if (key !== undefined) {
    // A failed read is not kept: the next ask reads again.
    value.catch(() => {
      if (kept.get(key)?.value === value) kept.delete(key);
    });
    if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value ?? key);
    kept.set(key, { at: now, value });
  }
  return value;
}
