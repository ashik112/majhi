import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SKIP = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);
const SOURCE = /\.(?:ts|tsx|js|mjs|cjs)$/;
const TEST = /\.test\.(?:ts|tsx|js|mjs|cjs)$/;
/** A git call with `worktree prune` as its arguments: `["worktree", "prune"]` and the like. */
const PRUNE = /["'`]worktree["'`]\s*,\s*["'`]prune["'`]/;

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) found.push(path);
  }
  return found;
}

describe("majhi's own git calls", () => {
  // A `git worktree prune` drops the entry of every worktree whose folder the caller cannot see at
  // that moment: a live task's checkout then stops being a git repo. Remove one entry instead.
  it("never run a plain `git worktree prune`", async () => {
    const files = [...(await sources(join(ROOT, "apps"))), ...(await sources(join(ROOT, "packages")))];
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (PRUNE.test(text)) offenders.push(relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});
