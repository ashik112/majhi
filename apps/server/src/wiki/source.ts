import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { type ContentHash, ContentHashSchema, RepoPathSchema } from "@majhi/shared";
import { isInside } from "../editor/allowed.ts";

/** A file larger than this is not cited: it is data or generated code, and reading it whole costs more than it shows. */
export const MAX_CITED_FILE_BYTES = 5_000_000;

/**
 * What the hash of cited lines is made of: each line without its line ending, joined by `\n`, as UTF-8.
 * The same text hashes the same wherever the file came from, so a later change in the lines is seen.
 */
export function hashLines(lines: readonly string[]): ContentHash {
  return ContentHashSchema.parse(createHash("sha256").update(lines.join("\n"), "utf8").digest("hex"));
}

/** The lines of a text: split on `\n`, a closing `\r` of each dropped, and no empty line after the last `\n`. */
export function linesOf(text: string): string[] {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export type ExportFile =
  | { ok: true; lines: readonly string[] }
  /** `outside-export`: the path is not one inside the repo, or leads out of the export (a symlink). `missing-file`: not there, not a file, or too large. */
  | { ok: false; reason: "missing-file" | "outside-export" };

/**
 * Reads files of a repo's clean export for citing. A path must be a plain relative path, and the file it
 * reaches, after symlinks, must lie inside the export: the writer's text is data and never decides what is read.
 * A file is read once per reader.
 */
export class ExportReader {
  private readonly root: Promise<string>;
  private readonly files = new Map<string, Promise<ExportFile>>();

  constructor(readonly dir: string) {
    this.root = realpath(dir);
  }

  file(path: string): Promise<ExportFile> {
    let found = this.files.get(path);
    if (found === undefined) {
      found = this.read(path);
      this.files.set(path, found);
    }
    return found;
  }

  private async read(path: string): Promise<ExportFile> {
    if (!RepoPathSchema.safeParse(path).success) return { ok: false, reason: "outside-export" };
    const root = await this.root;
    let real: string;
    try {
      real = await realpath(join(root, path));
    } catch {
      return { ok: false, reason: "missing-file" };
    }
    if (!isInside(real, root)) return { ok: false, reason: "outside-export" };
    try {
      const info = await stat(real);
      if (!info.isFile() || info.size > MAX_CITED_FILE_BYTES) return { ok: false, reason: "missing-file" };
      return { ok: true, lines: linesOf(await readFile(real, "utf8")) };
    } catch {
      return { ok: false, reason: "missing-file" };
    }
  }
}
