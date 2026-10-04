import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { BackupKindSchema } from "@majhi/shared";
import { z } from "zod";
import { UserError } from "../errors.ts";

export const MANIFEST_FILE = "manifest.json";
/** Inside the archive: files that land in the majhi home at the same relative path. */
export const DATA_DIR = "data";
/** Inside the archive: the config repository's history, as a git bundle. */
export const BUNDLE_FILE = "meta/config.bundle";

export const ManifestSchema = z.object({
  /** Layout of the archive. A newer layout than this build knows is refused. */
  format: z.literal(1),
  createdAt: z.string(),
  kind: BackupKindSchema,
  majhi: z.object({ version: z.string(), commit: z.string() }),
  /** Newest applied migration of each database, read from the snapshot itself. */
  migrations: z.object({ majhi: z.number().int().nullable(), memory: z.number().int().nullable() }),
  config: z.object({
    /** The commit the config history was at, when it has one. */
    head: z.string().nullable(),
    /** Whether `meta/config.bundle` holds its history. */
    bundle: z.boolean(),
  }),
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string() })),
  /** What is deliberately not in the archive, in plain words. */
  excluded: z.array(z.string()),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** The SHA-256 of a file, hex, read as a stream. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (c) => hash.update(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Every regular file under `root`, as `/`-separated paths relative to it. Symlinks and the like are returned as `unsafe`. */
export async function walk(root: string): Promise<{ files: string[]; unsafe: string[] }> {
  const files: string[] = [];
  const unsafe: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      const info = await lstat(full);
      if (info.isDirectory()) await visit(full);
      else if (info.isFile()) files.push(rel);
      else unsafe.push(rel);
    }
  }
  await visit(root);
  return { files: files.sort(), unsafe };
}

/** Lists every file under `root` except the manifest, with its size and checksum. */
export async function describeFiles(root: string): Promise<Manifest["files"]> {
  const { files, unsafe } = await walk(root);
  if (unsafe.length > 0) throw new Error(`Cannot back up ${unsafe[0]}: it is not a plain file.`);
  const out: Manifest["files"] = [];
  for (const path of files) {
    if (path === MANIFEST_FILE) continue;
    const full = join(root, path);
    out.push({ path, bytes: (await lstat(full)).size, sha256: await sha256File(full) });
  }
  return out;
}

/** Reads `manifest.json` from an unpacked archive. */
export async function readManifest(root: string): Promise<Manifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(root, MANIFEST_FILE), "utf8"));
  } catch {
    throw new UserError("The backup has no readable manifest, so it is not a majhi backup.", 409);
  }
  const format = z.object({ format: z.number() }).safeParse(raw);
  if (format.success && format.data.format > 1) {
    throw new UserError("The backup was made by a newer majhi than this one. Update majhi first.", 409);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) throw new UserError("The backup's manifest is not one this majhi understands.", 409);
  return parsed.data;
}

/**
 * Checks an unpacked archive against its manifest: every listed file is there with the recorded size
 * and checksum, and nothing else is. Throws a `Damaged` error naming the first problem.
 */
export async function checkFiles(root: string, manifest: Manifest): Promise<void> {
  const { files, unsafe } = await walk(root);
  if (unsafe.length > 0) throw new Damaged(`The backup holds ${unsafe[0]}, which is not a plain file.`);
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  for (const path of files) {
    if (path !== MANIFEST_FILE && !listed.has(path))
      throw new Damaged(`The backup holds ${path}, which its manifest does not list.`);
  }
  const present = new Set(files);
  for (const file of manifest.files) {
    if (!present.has(file.path)) throw new Damaged(`The backup is missing ${file.path}.`);
    const full = join(root, file.path);
    if ((await lstat(full)).size !== file.bytes) throw new Damaged(`${file.path} has the wrong size.`);
    if ((await sha256File(full)) !== file.sha256)
      throw new Damaged(`${file.path} does not match its checksum.`);
  }
}

/** A backup that is broken (as opposed to locked, or from a newer majhi). Only these count as bad. */
export class Damaged extends UserError {
  constructor(message: string) {
    super(`The backup is damaged: ${message}`, 409);
  }
}
