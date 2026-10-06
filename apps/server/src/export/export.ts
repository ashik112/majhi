import { Worker } from "node:worker_threads";
import type { ImageReader } from "./images.ts";
import type { PdfPrinter } from "./pdf.ts";
import type { FromWorker, RenderJob, ToWorker } from "./worker.ts";

export type ExportFormat = "html" | "pdf" | "docx";

export interface ExportedFile {
  body: Buffer;
  type: string;
}

const TYPES: Record<ExportFormat, string> = {
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** One render may take this long and this much heap; a 1 MB document of dense tables and code needs about 1 GB. */
const RENDER_TIMEOUT_MS = 60_000;
const RENDER_HEAP_MB = 1024;

/** Thrown when an export cannot be made, with the HTTP status that says why. */
export class ExportRefused extends Error {
  constructor(
    message: string,
    readonly status: 413 | 501 | 502,
  ) {
    super(message);
  }
}

/**
 * One markdown file in one format. One render makes the HTML tree; html prints it as a page, pdf
 * prints that page in Chromium, docx writes the same tree as a Word document. The render runs in a
 * worker thread, one at a time, so a long document never stalls the server or fills its memory.
 */
export async function exportMarkdown(
  file: string,
  name: string,
  format: ExportFormat,
  readImage: ImageReader,
  pdf: PdfPrinter | undefined,
): Promise<ExportedFile> {
  if (format === "pdf" && pdf === undefined) {
    throw new ExportRefused(
      "PDF export needs runner containers, and this majhi runs agents without them.",
      501,
    );
  }
  const job: RenderJob = {
    file,
    title: name.replace(/\.[^.]+$/, ""),
    format: format === "docx" ? "docx" : "html",
  };
  const body = await queued(() => renderInWorker(job, readImage));
  if (format !== "pdf" || pdf === undefined) return { body, type: TYPES[format] };
  try {
    return { body: await pdf(body.toString("utf8")), type: TYPES.pdf };
  } catch (err) {
    throw new ExportRefused(err instanceof Error ? err.message : String(err), 502);
  }
}

let line: Promise<unknown> = Promise.resolve();

/** Runs renders one after another: each may take a second of CPU and a lot of memory. */
function queued<T>(work: () => Promise<T>): Promise<T> {
  const turn = line.then(work, work);
  line = turn.catch(() => undefined);
  return turn;
}

/**
 * Where the worker's code is: next to this file when run from source (tsx, vitest), and
 * `dist/export/worker.js` in the server bundle (the build's second entry point).
 */
function workerFile(): { url: URL; execArgv?: string[] } {
  if (!import.meta.url.endsWith(".ts")) return { url: new URL("./export/worker.js", import.meta.url) };
  const loader = process.execArgv.some((a) => a.includes("tsx")) ? [] : ["--import", "tsx"];
  return { url: new URL("./worker.ts", import.meta.url), execArgv: [...process.execArgv, ...loader] };
}

function renderInWorker(job: RenderJob, readImage: ImageReader): Promise<Buffer> {
  const { url, execArgv } = workerFile();
  const worker = new Worker(url, {
    workerData: job,
    resourceLimits: { maxOldGenerationSizeMb: RENDER_HEAP_MB },
    ...(execArgv === undefined ? {} : { execArgv }),
  });
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | undefined, body?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (err !== undefined) reject(err);
      else resolve(body ?? Buffer.alloc(0));
    };
    const timer = setTimeout(
      () => finish(new ExportRefused("This document took too long to export. Download it as it is.", 413)),
      RENDER_TIMEOUT_MS,
    );
    worker.on("message", (msg: FromWorker) => {
      if (msg.type === "done")
        return finish(undefined, Buffer.from(msg.body.buffer, msg.body.byteOffset, msg.body.byteLength));
      if (msg.type === "error") return finish(new Error(msg.message));
      readImage(msg.src).then(
        (image) => {
          const reply: ToWorker = { type: "image", id: msg.id, file: image ?? null };
          if (!settled) worker.postMessage(reply);
        },
        () => {
          if (!settled) worker.postMessage({ type: "image", id: msg.id, file: null } satisfies ToWorker);
        },
      );
    });
    worker.on("error", (err: Error & { code?: string }) =>
      finish(
        err.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? new ExportRefused("This document is too big to export. Download it as it is.", 413)
          : err,
      ),
    );
    worker.on("exit", (code) => finish(new Error(`The export stopped (exit ${code}).`)));
  });
}
