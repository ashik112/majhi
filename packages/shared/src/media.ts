import type { MediaRef } from "./tasks.ts";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "ogg", "oga", "flac"]);
const PAGE = new Set(["html", "htm"]);

/** The lowercase extension of the last path segment, without the dot. Empty when there is none. */
export function extensionOf(path: string): string {
  const name = path.split(/[?#]/)[0]?.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** How the room shows a file, by its extension: inline media, a page card, or a plain file card. */
export function mediaKindOfPath(path: string): Exclude<MediaRef["kind"], "link"> {
  const ext = extensionOf(path);
  if (IMAGE.has(ext)) return "image";
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  if (PAGE.has(ext)) return "page";
  return "file";
}

/** `GET` URL of a file in a task's folder. Each segment is encoded; `..` and empty segments are not kept. */
export function taskFileUrl(taskId: string, relPath: string): string {
  const segments = relPath.split("/").filter((s) => s !== "" && s !== "." && s !== "..");
  return `/api/tasks/${taskId}/files/${segments.map(encodeURIComponent).join("/")}`;
}
