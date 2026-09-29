import { type RoomItem, repoFileUrl, taskFileUrl } from "@majhi/shared";
import { taskPathOf } from "../room/links";
import { type DiffContent, filesByRepo, touchedFiles } from "../room/model";

/**
 * What `?file=` points at: a file of the task folder (`docs/a.md`), of one of its repos
 * (`repo:web/SPEC.md`), or a changed file shown with its diffs (`changes:web/src/a.ts`, a
 * task-relative path).
 */
export type FileRef =
  | { kind: "task"; path: string }
  | { kind: "repo"; project: string; path: string }
  | { kind: "changes"; path: string };

export function parseFileRef(param: string): FileRef {
  if (param.startsWith("changes:")) return { kind: "changes", path: param.slice("changes:".length) };
  const repo = /^repo:([^/]+)\/(.+)$/.exec(param);
  if (repo?.[1] && repo[2]) return { kind: "repo", project: repo[1], path: repo[2] };
  return { kind: "task", path: param };
}

export function fileRefParam(ref: FileRef): string {
  if (ref.kind === "repo") return `repo:${ref.project}/${ref.path}`;
  return ref.kind === "changes" ? `changes:${ref.path}` : ref.path;
}

export function fileRefUrl(taskId: string, ref: FileRef): string {
  return ref.kind === "repo" ? repoFileUrl(taskId, ref.project, ref.path) : taskFileUrl(taskId, ref.path);
}

/** Where to look for a file, best first: the place it names, then the task's other places. */
export function fileCandidates(ref: FileRef, projects: readonly string[]): FileRef[] {
  if (ref.kind === "changes") return [ref];
  const repos: FileRef[] = projects
    .filter((p) => ref.kind !== "repo" || p !== ref.project)
    .map((project) => ({ kind: "repo", project, path: ref.path }));
  return ref.kind === "task" ? [ref, ...repos] : [ref, ...repos, { kind: "task", path: ref.path }];
}

/** The recorded edits of a changed file, found by its task-relative path. */
export function findChange(
  items: readonly RoomItem[],
  repos: readonly { worktree?: string | undefined }[],
  folder: string,
  path: string,
): { diffs: DiffContent[]; change: "edit" | "delete" | "move" } | undefined {
  for (const group of filesByRepo(touchedFiles(items), repos)) {
    for (const file of group.files) {
      if (viewablePath({ ...file, change: "edit" }, group.repo?.worktree, folder) === path) return file;
    }
  }
  return undefined;
}

const FILE_TOKEN = /((?:[\w-]+\/)*[\w.-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,7})/;
const BARE_EXT = new Set(
  "md mdx ts tsx js jsx mjs cjs json yml yaml toml txt css scss html sql sh py go rs rb java kt swift lock ini cfg conf csv svg png jpg pdf".split(
    " ",
  ),
);

/** A relative file path with an extension; bare names need a well-known extension so "e.g" and "v1.2" stay text. */
export function isFilePath(token: string): boolean {
  const m = FILE_TOKEN.exec(token);
  if (m?.[1] !== token || token.startsWith("/") || token.startsWith(".")) return false;
  if (token.split("/").some((seg) => seg.startsWith("."))) return false;
  if (token.includes("/")) return true;
  return BARE_EXT.has(token.slice(token.lastIndexOf(".") + 1).toLowerCase());
}

const SKIP =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|\[[^\]\n]*\]\([^)\n]*\)|<https?:[^>\n]*>|https?:\/\/[^\s)]+|`([^`\n]+)`|(?<![\w./@:#-])((?:[\w-]+\/)*[\w.-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,7})(?![\w/@-]|\.\w))/g;

/** Markdown with every file path in it turned into a link, for the viewer. Code blocks and existing links stay as written. */
export function linkifyPaths(text: string): string {
  return text.replace(SKIP, (whole: string, _all, code: string | undefined, plain: string | undefined) => {
    if (code !== undefined) return isFilePath(code) ? `[${whole}](${code})` : whole;
    if (plain !== undefined) return isFilePath(plain) ? `[${plain}](${plain})` : whole;
    return whole;
  });
}

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
