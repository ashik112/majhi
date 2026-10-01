import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ATTACHMENT_TYPES_TEXT,
  type Attachment,
  attachmentAllowed,
  attachmentMime,
  UPLOAD_MAX_BYTES,
} from "@majhi/shared";
import { z } from "zod";
import { errorCode, UserError } from "../errors.ts";

/** Unused uploads are deleted after this long. */
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const MetaSchema = z.object({
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  at: z.number(),
  /** The org of the task the file came from. Absent for the owner's uploads and the LOCAL boss chat. */
  org: z.string().optional(),
});
type Meta = z.infer<typeof MetaSchema>;

/**
 * Files the owner attached before the task or message exists, kept in
 * `<majhi home>/cache/uploads/` (git-ignored) until a command takes them.
 */
export class UploadStore {
  readonly dir: string;

  constructor(
    majhiHome: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = join(majhiHome, "cache", "uploads");
  }

  /** Stores one file. Images are detected by mime type. */
  async save(input: { name: string; mime: string; data: Uint8Array; org?: string }): Promise<Attachment> {
    const name = safeName(input.name);
    assertAttachable(name, input.data.byteLength, input.mime);
    const id = randomUUID();
    const mime = input.mime.trim().toLowerCase() || attachmentMime(name) || "application/octet-stream";
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.dataPath(id), input.data);
    return this.writeMeta(id, { name, mime, size: input.data.byteLength, at: this.now(), org: input.org });
  }

  /**
   * Copies the file at `path` into the store without reading it into memory. The caller checked
   * that the path is a regular file it may use.
   */
  async saveFile(input: { path: string; name: string; org?: string | undefined }): Promise<Attachment> {
    const name = safeName(input.name);
    const size = (await stat(input.path)).size;
    assertAttachable(name, size, "");
    const id = randomUUID();
    await mkdir(this.dir, { recursive: true });
    await copyFile(input.path, this.dataPath(id));
    return this.writeMeta(id, {
      name,
      mime: attachmentMime(name) ?? "application/octet-stream",
      size,
      at: this.now(),
      org: input.org,
    });
  }

  private async writeMeta(id: string, meta: Meta): Promise<Attachment> {
    await writeFile(this.metaPath(id), JSON.stringify(meta));
    return {
      id,
      kind: IMAGE_MIMES.has(meta.mime) ? "image" : "file",
      name: meta.name,
      mime: meta.mime,
      size: meta.size,
    };
  }

  /** The org the upload came from (undefined for the owner's), or a UserError when it is gone. */
  async orgOf(id: string): Promise<string | undefined> {
    return (await this.meta(id)).org;
  }

  /** Throws when any of the uploads is missing, so nothing is moved before a later one fails. */
  async assertAll(ids: readonly string[]): Promise<void> {
    for (const id of ids) await this.meta(id);
  }

  /** Moves an upload into `dir` under a free name and returns its attachment. The upload is gone afterwards. */
  async take(id: string, dir: string): Promise<Attachment> {
    const meta = await this.meta(id);
    await mkdir(dir, { recursive: true });
    const name = await freeName(dir, meta.name);
    await moveFile(this.dataPath(id), join(dir, name));
    await rm(this.metaPath(id), { force: true });
    return {
      id,
      kind: IMAGE_MIMES.has(meta.mime) ? "image" : "file",
      name: meta.name,
      mime: meta.mime,
      size: meta.size,
      path: name,
    };
  }

  /** Deletes uploads older than a day. Returns how many. */
  async sweep(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (errorCode(err) === "ENOENT") return 0;
      throw err;
    }
    let removed = 0;
    const cutoff = this.now() - UPLOAD_MAX_AGE_MS;
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const id = name.slice(0, -".json".length);
      const meta = await this.meta(id).catch(() => undefined);
      const old =
        meta === undefined ? await this.fileOlderThan(join(this.dir, name), cutoff) : meta.at < cutoff;
      if (!old) continue;
      await rm(this.dataPath(id), { force: true });
      await rm(this.metaPath(id), { force: true });
      removed++;
    }
    return removed;
  }

  private async fileOlderThan(path: string, cutoff: number): Promise<boolean> {
    const info = await stat(path).catch(() => undefined);
    return info !== undefined && info.mtimeMs < cutoff;
  }

  private async meta(id: string): Promise<Meta> {
    if (!UPLOAD_ID.test(id)) throw new UserError(`"${id}" is not an upload id.`);
    try {
      return MetaSchema.parse(JSON.parse(await readFile(this.metaPath(id), "utf8")));
    } catch (err) {
      if (errorCode(err) === "ENOENT") {
        throw new UserError(
          `Upload ${id} is gone: uploads are kept for 24 hours and each one can be used once. Upload the file again (the Attach button, or majhi_uploads_create for a file in your task folder).`,
        );
      }
      throw err;
    }
  }

  private dataPath(id: string): string {
    return join(this.dir, `${id}.bin`);
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}

/** Throws a UserError that says what is wrong with the file and what is allowed. */
export function assertAttachable(name: string, size: number, mime: string): void {
  if (size > UPLOAD_MAX_BYTES) {
    throw new UserError(
      `"${name}" is ${(size / 1024 / 1024).toFixed(1)} MB, over the limit of ${UPLOAD_MAX_BYTES / 1024 / 1024} MB. Attach a smaller file.`,
    );
  }
  if (!attachmentAllowed(name, mime)) {
    throw new UserError(`"${name}" is not an allowed file type. Allowed: ${ATTACHMENT_TYPES_TEXT}.`);
  }
}

/** A file name with no folders, control characters or leading dots. */
export function safeName(name: string): string {
  const cleaned = [...basename(name.replace(/\\/g, "/"))]
    .map((ch) => (ch.charCodeAt(0) < 32 || '<>:"|?*'.includes(ch) ? "_" : ch))
    .join("")
    .replace(/^\.+/, "")
    .trim();
  return (cleaned === "" ? "file" : cleaned).slice(0, 120);
}

/** `name`, or `name-2.ext`, `name-3.ext` when taken. */
export async function freeName(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Rename, or copy and delete when the folders are on different disks. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if (errorCode(err) !== "EXDEV") throw err;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}
