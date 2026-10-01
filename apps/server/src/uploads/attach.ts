import { randomUUID } from "node:crypto";
import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Attachment, attachmentMime } from "@majhi/shared";
import { errorCode, UserError } from "../errors.ts";
import { assertAttachable, freeName, safeName, UPLOAD_ID, type UploadStore } from "./store.ts";

/** The task a caller works in: the only folder it may attach files from. */
export interface AttachSource {
  task: string;
  folder: string;
  /** Absent for a LOCAL task such as the boss chat. */
  org: string | undefined;
}

/** The task the files go to. `org` is undefined for a task with no org. */
export interface AttachTarget {
  org: string | undefined;
}

/** One entry of `attachments`, checked and ready to move or copy in. */
export type PlannedAttachment =
  | { kind: "upload"; id: string }
  | { kind: "path"; real: string; name: string; size: number };

const HOW =
  "Attachments take an upload id (from majhi_uploads_create or the owner's Attach button) or a path to a file in your own task folder, like attachments/image.png.";

function inOrg(org: string | undefined): string {
  return org === undefined ? "with no org" : `in org ${org}`;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * The real path of a regular file inside the caller's task folder. `entry` is relative to the folder,
 * or absolute inside it. Symlinks count by where they lead, so a link out of the folder is refused.
 * `orId` words the not-found error for places that also take an upload id.
 */
export async function resolveTaskFile(
  source: AttachSource,
  entry: string,
  orId: boolean,
): Promise<{ real: string; name: string; size: number }> {
  const missing = () =>
    new UserError(
      orId
        ? `"${entry}" is not an upload id or a file in your task folder (${source.folder}). ${HOW}`
        : `"${entry}" is not a file in your task folder (${source.folder}). Pass a path to a file in your own task folder, like attachments/image.png.`,
    );
  const outside = () =>
    new UserError(
      `"${entry}" is outside your task folder (${source.folder}). You can only attach files from your own task folder. Copy the file into it, then pass its path there, like attachments/image.png.`,
    );
  let root: string;
  try {
    root = await realpath(source.folder);
  } catch {
    throw missing();
  }
  const wanted = resolve(source.folder, entry);
  if (!inside(wanted, source.folder) && !inside(wanted, root)) throw outside();
  let real: string;
  try {
    real = await realpath(wanted);
  } catch (err) {
    if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") throw missing();
    throw err;
  }
  if (!inside(real, root)) throw outside();
  const info = await stat(real);
  if (!info.isFile()) {
    throw new UserError(`"${entry}" is a folder, not a file. Attach one file, or zip the folder first.`);
  }
  const name = safeName(basename(real));
  assertAttachable(name, info.size, "");
  return { real, name, size: info.size };
}

/**
 * Checks every entry of `attachments`: an upload id (still there, used once, from the target's org)
 * or a path in the caller's own task folder. Throws a UserError that says what is wrong and what is
 * accepted. Changes nothing, so nothing is moved before a later entry fails. Without a `target`
 * the org of the destination is not checked yet (the task does not exist).
 */
export async function planAttachments(
  uploads: UploadStore,
  entries: readonly string[],
  source: AttachSource | undefined,
  target: AttachTarget | undefined,
): Promise<PlannedAttachment[]> {
  const seen = new Set<string>();
  const planned: PlannedAttachment[] = [];
  for (const entry of entries) {
    if (UPLOAD_ID.test(entry)) {
      if (seen.has(entry)) {
        throw new UserError(
          `Upload ${entry} is listed more than once in attachments. List each upload once.`,
        );
      }
      seen.add(entry);
      const org = await uploads.orgOf(entry);
      if (org !== undefined && target !== undefined && target.org !== org) {
        throw new UserError(
          `Upload ${entry} came from a task in org ${org}, so it cannot be attached to a task ${inOrg(target.org)}. Files stay inside their org: upload the file again from a task in the same org.`,
        );
      }
      planned.push({ kind: "upload", id: entry });
      continue;
    }
    if (source === undefined) {
      throw new UserError(
        `"${entry}" is not an upload id. From here, attachments take an upload id from the Attach button. A file path works only for an agent, from its own task folder.`,
      );
    }
    const file = await resolveTaskFile(source, entry, true);
    if (source.org !== undefined && target !== undefined && target.org !== source.org) {
      throw new UserError(
        `"${entry}" is in task ${source.task}, which is in org ${source.org}, so it cannot be attached to a task ${inOrg(target.org)}. Files stay inside their org.`,
      );
    }
    planned.push({ kind: "path", ...file });
  }
  return planned;
}

/** Moves uploads and copies path files into `dir`, under free names. The originals of paths stay. */
export async function takePlanned(
  uploads: UploadStore,
  planned: readonly PlannedAttachment[],
  dir: string,
): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const item of planned) {
    if (item.kind === "upload") {
      out.push(await uploads.take(item.id, dir));
      continue;
    }
    await mkdir(dir, { recursive: true });
    const path = await freeName(dir, item.name);
    await copyFile(item.real, join(dir, path));
    const mime = attachmentMime(item.name) ?? "application/octet-stream";
    out.push({
      id: randomUUID(),
      kind: mime.startsWith("image/") ? "image" : "file",
      name: item.name,
      mime,
      size: item.size,
      path,
    });
  }
  return out;
}
