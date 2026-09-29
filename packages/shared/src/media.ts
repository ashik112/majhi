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

/** `GET` URL of a file in one of a task's repos: its worktree once created, else the project's checkout. */
export function repoFileUrl(taskId: string, project: string, relPath: string): string {
  const segments = relPath.split("/").filter((s) => s !== "" && s !== "." && s !== "..");
  return `/api/tasks/${taskId}/repo/${encodeURIComponent(project)}/files/${segments.map(encodeURIComponent).join("/")}`;
}

/** How the in-app file viewer shows a file. */
export type ViewerKind = "markdown" | "image" | "pdf" | "page" | "video" | "audio" | "text";

const MARKDOWN = new Set(["md", "markdown", "mdown"]);
/** Pages and svg run scripts, so they are never shown inside majhi: the viewer offers the source. */
const SANDBOXED_PAGE = new Set(["html", "htm", "svg"]);

export function viewerKindOfPath(path: string): ViewerKind {
  const ext = extensionOf(path);
  if (MARKDOWN.has(ext)) return "markdown";
  if (SANDBOXED_PAGE.has(ext)) return "page";
  if (ext === "pdf") return "pdf";
  const media = mediaKindOfPath(path);
  if (media === "image" || media === "video" || media === "audio") return media;
  return "text";
}

/** highlight.js language names by extension or file name. Unknown files stay plain. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  go: "go",
  rs: "rust",
  sql: "sql",
  css: "css",
  scss: "scss",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  rb: "ruby",
  php: "php",
  kt: "kotlin",
  swift: "swift",
};

export function codeLanguageOf(path: string): string | undefined {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return LANGUAGES[extensionOf(path)];
}
