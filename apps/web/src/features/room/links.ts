import { type ViewerKind, viewerKindOfPath } from "@majhi/shared";

/** Which markdown targets become links or images, and what they point at. */

const WEB_HREF = /^(https?:\/\/|mailto:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function isWebHref(href: string): boolean {
  return WEB_HREF.test(href);
}

/**
 * A target the room can use: a web or mail link, or a path to a file in the task folder (relative,
 * or absolute under the folder). Anything else (javascript:, data:, other schemes, `//host`) is
 * dropped and the text stays plain.
 */
export function safeHref(href: string): string | undefined {
  if (WEB_HREF.test(href)) return href;
  if (HAS_SCHEME.test(href) && !/^file:\/\//i.test(href)) return undefined;
  if (href.startsWith("//") || href.startsWith("#") || href === "") return undefined;
  return href;
}

/**
 * The path of a file inside the task folder, relative to it, or undefined when the target is not
 * one: a web link, a path outside the folder, or one that climbs out of it.
 *
 * `baseDir` is the folder of the document the target is written in (relative to the task folder),
 * so `../media/a.png` in `docs/plan.md` is `media/a.png`. Without it, `..` is never accepted.
 */
export function taskPathOf(target: string, folder: string | undefined, baseDir = ""): string | undefined {
  if (WEB_HREF.test(target)) return undefined;
  let path = target.replace(/^file:\/\//i, "").split(/[?#]/)[0] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  let base: string[] = [];
  if (path.startsWith("/")) {
    const root = folder?.replace(/\/+$/, "");
    if (root === undefined || root === "" || !path.startsWith(`${root}/`)) return undefined;
    path = path.slice(root.length + 1);
  } else {
    base = baseDir.split("/").filter((seg) => seg !== "" && seg !== ".");
  }
  const out = [...base];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (base.length === 0 || out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length === 0 ? undefined : out.join("/");
}

/** The folder part of a task-relative path: "docs/a.md" gives "docs", "a.md" gives "". */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export type LinkTarget =
  | { type: "web"; href: string }
  | { type: "file"; path: string; kind: ViewerKind }
  | { type: "none" };

/** What a markdown target points at: a web address, a file of the task folder, or nothing usable. */
export function classifyTarget(target: string, folder: string | undefined, baseDir = ""): LinkTarget {
  const safe = safeHref(target);
  if (safe === undefined) return { type: "none" };
  if (isWebHref(safe)) return { type: "web", href: safe };
  const path = taskPathOf(safe, folder, baseDir);
  return path === undefined ? { type: "none" } : { type: "file", path, kind: viewerKindOfPath(path) };
}

/**
 * How a link to a task file shows. Inside a sentence it is always a plain inline link, so the line
 * height never changes. Alone on its own line it may be a card, or a player for a clip.
 */
export function presentFileLink(kind: ViewerKind, ownLine: boolean): "inline" | "card" | "player" {
  if (!ownLine) return "inline";
  return kind === "video" || kind === "audio" ? "player" : "card";
}
