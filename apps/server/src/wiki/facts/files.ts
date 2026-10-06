import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

/**
 * Read-only access to one project's checkout for the map. Every read stays inside the checkout: a
 * symlink that leads out of it, a path with `..` and a file that is not a regular file read as missing.
 * Reads are bounded, so a huge file or folder never stalls an update.
 */

/** The biggest file read whole. A bigger one reads as missing: configs and sources are far smaller. */
export const MAX_FILE_BYTES = 256 * 1024;
/** Folders the walk never enters: dependencies, build output, caches. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
  "site-packages",
]);

export class ProjectFiles {
  private root: Promise<string | undefined> | undefined;

  constructor(readonly path: string) {}

  private realRoot(): Promise<string | undefined> {
    this.root ??= realpath(this.path).then(
      (p) => p,
      () => undefined,
    );
    return this.root;
  }

  /** The real path of `rel` when it is inside the checkout, else undefined. */
  private async inside(rel: string): Promise<string | undefined> {
    const root = await this.realRoot();
    if (root === undefined) return undefined;
    let real: string;
    try {
      real = await realpath(join(root, rel));
    } catch {
      return undefined;
    }
    return real === root || real.startsWith(root + sep) ? real : undefined;
  }

  /** A regular file's text, or undefined when it is missing, outside, too big or not text. */
  async read(rel: string): Promise<string | undefined> {
    const real = await this.inside(rel);
    if (real === undefined) return undefined;
    try {
      const info = await lstat(real);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
      const buf = await readFile(real);
      return buf.includes(0) ? undefined : buf.toString("utf8");
    } catch {
      return undefined;
    }
  }

  /** What identifies the file's contents for a cache: size and modified time, or `-` when it is not there. */
  async stamp(rel: string): Promise<string> {
    const real = await this.inside(rel);
    if (real === undefined) return "-";
    try {
      const info = await lstat(real);
      return `${info.size}:${info.mtimeMs}`;
    } catch {
      return "-";
    }
  }

  async exists(rel: string): Promise<boolean> {
    const real = await this.inside(rel);
    return real !== undefined;
  }

  /** The entries of a folder inside the checkout: name and whether it is a folder. Empty when missing. */
  async list(rel: string): Promise<{ name: string; dir: boolean }[]> {
    const real = await this.inside(rel);
    if (real === undefined) return [];
    try {
      const entries = await readdir(real, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() || e.isDirectory())
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  /**
   * Files under a folder, breadth first, never entering a skipped folder. Stops at `limit` entries
   * looked at, so a monorepo with a hundred thousand files costs the same as a small one. Paths are
   * relative to the checkout with `/`.
   */
  async walk(
    rel: string,
    options: { maxDepth: number; limit: number },
  ): Promise<{ files: string[]; cut: boolean }> {
    const files: string[] = [];
    let seen = 0;
    let cut = false;
    let level: string[] = [rel];
    for (let depth = 0; depth <= options.maxDepth && level.length > 0 && !cut; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        for (const entry of await this.list(dir)) {
          seen += 1;
          if (seen > options.limit) {
            cut = true;
            break;
          }
          const path = dir === "" || dir === "." ? entry.name : `${dir}/${entry.name}`;
          if (entry.dir) {
            if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) next.push(path);
          } else files.push(path);
        }
        if (cut) break;
      }
      level = next;
    }
    return { files, cut };
  }
}
