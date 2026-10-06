import { createReadStream, type Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import {
  type ApiError,
  type DownloadFormat,
  DownloadFormatSchema,
  downloadName,
  EXPORT_SOURCE_LIMIT,
  extensionOf,
  taskPathOf,
  viewerKindOfPath,
} from "@majhi/shared";
import { type Context, Hono } from "hono";
import { ExportRefused, exportMarkdown } from "../export/export.ts";
import { IMAGE_LIMIT, type ImageReader } from "../export/images.ts";
import type { PdfPrinter } from "../export/pdf.ts";

/** By extension. Anything else is a download, so a browser never guesses. */
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  pdf: "application/pdf",
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  // Browsers download text/markdown; plain text shows in the tab.
  md: "text/plain; charset=utf-8",
  markdown: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
};

/**
 * Pages and images with script get an opaque origin: they run, but cannot reach majhi's API, whose
 * Origin check refuses `null`.
 */
const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
const SANDBOXED = new Set(["html", "htm", "svg"]);

export interface TaskFilesDeps {
  /** The task folder, or undefined when there is no such task. */
  folderOf(taskId: string): string | undefined;
  /** The repos of a task (checkout and worktree), or undefined when there is no such task. */
  reposOf?(taskId: string): { project: string; source: string; worktree?: string | undefined }[] | undefined;
  /** Prints exported documents to PDF; absent where runs have no runner container. */
  pdf?: PdfPrinter | undefined;
}

const TASK_ID = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/;
const PREFIX = /^\/api\/tasks\/[^/]+\/files\//;
const REPO_PREFIX = /^\/api\/tasks\/[^/]+\/repo\/[^/]+\/files\//;

/**
 * `GET /api/tasks/<id>/files/<path>`: a file from the task folder, so the room can show what the
 * agent made. With `?meta=1` it answers `{ size, modified }` instead of the content. Nothing outside the folder (also through symlinks) and nothing behind a dot name
 * (`.git`, `.env`) is ever served.
 */
export function taskFileRoutes(deps: TaskFilesDeps): Hono {
  const app = new Hono();
  const refuse = (c: { json: (b: ApiError, s: 403 | 404) => Response }, status: 403 | 404, error: string) =>
    c.json({ error }, status);

  app.get("/:id/files/*", async (c) => {
    const id = c.req.param("id");
    const folder = TASK_ID.test(id) ? deps.folderOf(id) : undefined;
    if (folder === undefined) return refuse(c, 404, "No such task.");
    return serveFrom(c, folder, PREFIX, "task folder");
  });

  // A file of one of the task's repos: its worktree once created, else the project's own checkout.
  app.get("/:id/repo/:project/files/*", async (c) => {
    const id = c.req.param("id");
    const repos = TASK_ID.test(id) ? deps.reposOf?.(id) : undefined;
    const repo = repos?.find((r) => r.project === c.req.param("project"));
    if (repo === undefined) return refuse(c, 404, "No such task or project.");
    let root = repo.source;
    if (repo.worktree !== undefined && (await stat(repo.worktree).catch(() => undefined))?.isDirectory()) {
      root = repo.worktree;
    }
    return serveFrom(c, root, REPO_PREFIX, "project");
  });

  async function serveFrom(c: Context, folder: string, prefix: RegExp, what: string): Promise<Response> {
    let segments: string[];
    try {
      segments = c.req.path.replace(prefix, "").split("/").map(decodeURIComponent);
    } catch {
      return refuse(c, 404, "Not found.");
    }
    const notes = prefix === PREFIX;
    return serveSegments(
      c,
      folder,
      segments,
      what,
      (parts) => (notes && isHandoffNote(parts) ? false : parts.some((s) => s.startsWith("."))),
      { pdf: deps.pdf },
    );
  }
  return app;
}

/** Says which names under a root are never served: checked on the asked path and again on the resolved one. */
export type HiddenRule = (parts: readonly string[]) => boolean;

/**
 * The file `segments` (already percent-decoded) name under `folder`, or why it may not be read. The
 * one access rule of the viewer: nothing outside the folder (also through symlinks), no hidden name.
 * Serving a file, and every image an exported document inlines, goes through here.
 */
export async function resolveInside(
  folder: string,
  segments: string[],
  what: string,
  hidden: HiddenRule,
): Promise<{ target: string; info: Stats } | { status: 403 | 404; error: string }> {
  if (segments.some((s) => s.includes("\0") || s.includes("\\"))) return { status: 404, error: "Not found." };
  // Empty segments (a trailing slash) are dropped; `..` and dot names are refused outright.
  segments = segments.filter((s) => s !== "");
  if (segments.length === 0) return { status: 404, error: "Not found." };
  if (hidden(segments)) return { status: 403, error: "Hidden files are not served." };

  let root: string;
  let target: string;
  try {
    root = await realpath(folder);
    target = await realpath(join(root, ...segments));
  } catch {
    return { status: 404, error: "Not found." };
  }
  const rel = relative(root, target);
  const parts = rel.split(sep);
  if (rel === "" || rel.startsWith("..") || hidden(parts)) {
    return { status: 403, error: `That file is outside the ${what}.` };
  }
  const info = await stat(target).catch(() => undefined);
  if (info === undefined || !info.isFile()) return { status: 404, error: "Not found." };
  return { target, info };
}

/**
 * Serves one file of `folder` named by `segments` (still percent-decoded by the caller), with ranges and `?meta=1`.
 * Nothing outside the folder is served, also through symlinks; `hidden` says which names are refused.
 * `?download=<format>` sends it as an attachment: `raw` as it is, and a markdown file as html, pdf or docx.
 */
export async function serveSegments(
  c: Context,
  folder: string,
  segments: string[],
  what: string,
  /** True for a path that must not be served: checked on the asked path and again on the resolved one. */
  hidden: HiddenRule,
  options: { pdf?: PdfPrinter | undefined } = {},
): Promise<Response> {
  const refuse = (status: 400 | 403 | 404 | 413, error: string) =>
    c.json({ error } satisfies ApiError, status);
  const found = await resolveInside(folder, segments, what, hidden);
  if ("error" in found) return refuse(found.status, found.error);
  const { target, info } = found;

  // `?meta=1`: what the in-app viewer shows in its header. Same checks as above, no content.
  if (c.req.query("meta") === "1") {
    return c.json({ size: info.size, modified: info.mtime.toISOString() }, 200, {
      "Cache-Control": "no-store",
    });
  }

  const asked = segments.filter((s) => s !== "");
  const name = asked[asked.length - 1] ?? "file";
  let download: DownloadFormat | undefined;
  const format = c.req.query("download");
  if (format !== undefined) {
    const parsed = DownloadFormatSchema.safeParse(format);
    if (!parsed.success) return refuse(400, "Download as raw, html, pdf or docx.");
    download = parsed.data;
  }
  if (download !== undefined && download !== "raw") {
    if (viewerKindOfPath(name) !== "markdown")
      return refuse(400, "Only a markdown file exports as html, pdf or docx.");
    if (info.size > EXPORT_SOURCE_LIMIT) {
      return refuse(413, "This file is too big to export. Download it as it is.");
    }
    const baseDir = asked.slice(0, -1).join("/");
    const readImage: ImageReader = async (src) => {
      const path = taskPathOf(src, folder, baseDir);
      if (path === undefined) return undefined;
      const image = await resolveInside(folder, path.split("/"), what, hidden);
      const type = TYPES[extensionOf(path)];
      if ("error" in image || type === undefined || !type.startsWith("image/")) return undefined;
      if (image.info.size > IMAGE_LIMIT) return undefined;
      return { bytes: await readFile(image.target), type };
    };
    try {
      const file = await exportMarkdown(target, name, download, readImage, options.pdf);
      const body = new Uint8Array(file.body.buffer as ArrayBuffer, file.body.byteOffset, file.body.byteLength);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": file.type,
          "Content-Length": String(file.body.length),
          "Content-Disposition": attachment(downloadName(name, download)),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          ...(download === "html" ? { "Content-Security-Policy": SANDBOX } : {}),
        },
      });
    } catch (err) {
      if (err instanceof ExportRefused) return c.json({ error: err.message } satisfies ApiError, err.status);
      throw err;
    }
  }

  const ext = extensionOf(target);
  const headers = new Headers({
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  });
  if (SANDBOXED.has(ext)) headers.set("Content-Security-Policy", SANDBOX);
  if (download === "raw") headers.set("Content-Disposition", attachment(downloadName(name, "raw")));
  else if (TYPES[ext] === undefined) headers.set("Content-Disposition", "attachment");

  const range = parseRange(c.req.header("range"), info.size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  const [start, end] = range ?? [0, Math.max(0, info.size - 1)];
  headers.set("Content-Length", String(info.size === 0 ? 0 : end - start + 1));
  if (range !== undefined) headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
  if (c.req.method === "HEAD" || info.size === 0)
    return new Response(null, { status: range ? 206 : 200, headers });
  const stream = Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream;
  return new Response(stream, { status: range ? 206 : 200, headers });
}

/** `Content-Disposition` for a download named `name`, with an ASCII fallback for old clients. */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** One `bytes=a-b`, `bytes=a-` or `bytes=-n` range. Anything else is served whole. */
export function parseRange(
  header: string | undefined,
  size: number,
): [number, number] | "unsatisfiable" | undefined {
  const m = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null || (m[1] === "" && m[2] === "")) return undefined;
  if (size === 0) return "unsatisfiable";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const tail = Number(m[2]);
    if (tail === 0) return "unsatisfiable";
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return [start, end];
}

/**
 * The one hidden place the task folder serves: handoff notes, `.handoffs/<agent>-<n>.md` (5.13),
 * so the room can open them. Nothing else under a dot name, and nothing deeper.
 */
export function isHandoffNote(segments: readonly string[]): boolean {
  return (
    segments.length === 2 &&
    segments[0] === ".handoffs" &&
    /^[a-z0-9][a-z0-9-]*-\d+\.md$/.test(segments[1] ?? "")
  );
}
