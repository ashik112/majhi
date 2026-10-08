import { isWebHref, safeHref, taskFileReference, type ViewerKind, viewerKindOfPath } from "@majhi/shared";

/** Which markdown targets become links or images, and what they point at. The rules live in shared, for the export too. */
export { dirOf, isWebHref, safeHref, taskPathOf } from "@majhi/shared";

export type LinkTarget =
  | { type: "web"; href: string }
  | { type: "file"; path: string; kind: ViewerKind; task?: string }
  | { type: "none" };

/** What a markdown target points at: a web address, a file of the task folder, or nothing usable. */
export function classifyTarget(target: string, folder: string | undefined, baseDir = ""): LinkTarget {
  const safe = safeHref(target);
  if (safe === undefined) return { type: "none" };
  if (isWebHref(safe)) return { type: "web", href: safe };
  const ref = taskFileReference(safe, folder, baseDir);
  return ref === undefined ? { type: "none" } : { type: "file", ...ref, kind: viewerKindOfPath(ref.path) };
}

/**
 * How a link to a task file shows. Inside a sentence it is always a plain inline link, so the line
 * height never changes. Alone on its own line it may be a card, or a player for a clip.
 */
export function presentFileLink(kind: ViewerKind, ownLine: boolean): "inline" | "card" | "player" {
  if (!ownLine) return "inline";
  return kind === "video" || kind === "audio" ? "player" : "card";
}
