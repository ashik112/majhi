import type { RoomItem } from "@majhi/shared";
import { taskPathOf } from "../room/links";

/** Text files longer than this show their first part only. */
export const TEXT_LIMIT = 1_000_000;
/** Above this size the source is shown without syntax colors, so a big file does not stall the tab. */
export const HIGHLIGHT_LIMIT = 300_000;

/**
 * The id of the last completed tool call that touched `path` (relative to the task folder), or
 * undefined. It changes when the agent edits the file, which is the viewer's cue to load it again.
 */
export function fileEditStamp(items: readonly RoomItem[], folder: string, path: string): string | undefined {
  let stamp: string | undefined;
  for (const item of items) {
    if (item.type !== "tool" || item.status !== "completed") continue;
    const paths = [...item.locations, ...item.content.flatMap((c) => (c.type === "diff" ? [c.path] : []))];
    if (paths.some((p) => taskPathOf(p, folder) === path)) stamp = item.id;
  }
  return stamp;
}

/**
 * The task-relative path of a touched file the viewer can open, or undefined for a deleted file
 * or one outside the task folder. A relative path is inside the repo's worktree.
 */
export function viewablePath(
  file: { path: string; change: "edit" | "delete" | "move" },
  worktree: string | undefined,
  folder: string,
): string | undefined {
  if (file.change === "delete") return undefined;
  if (file.path.startsWith("/")) return taskPathOf(file.path, folder);
  return worktree === undefined
    ? undefined
    : taskPathOf(`${worktree.replace(/\/+$/, "")}/${file.path}`, folder);
}

/** A fence for `text` that no line of it can close, for showing source through the markdown renderer. */
export function fenceFor(text: string): string {
  let longest = 2;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(longest + 1);
}

/** True when the first bytes hold a NUL, which text files do not. */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i += 1) if (bytes[i] === 0) return true;
  return false;
}

/** The line numbers column for `text`: "1\n2\n3" with one number per line. */
export function lineNumbers(text: string): string {
  const count = text === "" ? 1 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return Array.from({ length: Math.max(1, count) }, (_, i) => String(i + 1)).join("\n");
}
