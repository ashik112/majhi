import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { documentDocx } from "./docx.ts";
import { documentHtml } from "./html.ts";
import type { ImageFile } from "./images.ts";
import { renderDocument } from "./render.ts";

/** What the server asks of one export worker. */
export interface RenderJob {
  /** The markdown file, already checked by the viewer's access rule. */
  file: string;
  /** The title when the document has no top heading. */
  title: string;
  format: "html" | "docx";
}

export type FromWorker =
  | { type: "image"; id: number; src: string }
  | { type: "done"; body: Uint8Array }
  | { type: "error"; message: string };

export type ToWorker = { type: "image"; id: number; file: ImageFile | null };

/**
 * One export, off the server's event loop: parsing a long markdown file takes seconds. Images are
 * asked of the server, which reads them under the viewer's access rule; this thread reads nothing
 * but the file it was given.
 */
async function run(port: NonNullable<typeof parentPort>, job: RenderJob): Promise<void> {
  const waiting = new Map<number, (file: ImageFile | undefined) => void>();
  let next = 0;
  port.on("message", (msg: ToWorker) => {
    waiting.get(msg.id)?.(
      msg.file === null ? undefined : { bytes: Buffer.from(msg.file.bytes), type: msg.file.type },
    );
    waiting.delete(msg.id);
  });
  const readImage = (src: string) =>
    new Promise<ImageFile | undefined>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      port.postMessage({ type: "image", id, src } satisfies FromWorker);
    });
  const doc = await renderDocument(await readFile(job.file, "utf8"), job.title, readImage);
  // Fresh arrays, never a slice of Node's shared buffer pool, so the transfer moves only this file.
  const body =
    job.format === "docx"
      ? new Uint8Array(await documentDocx(doc))
      : new TextEncoder().encode(await documentHtml(doc));
  port.postMessage({ type: "done", body } satisfies FromWorker, [body.buffer as ArrayBuffer]);
}

if (parentPort !== null) {
  const port = parentPort;
  run(port, workerData as RenderJob).catch((err: unknown) => {
    port.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    } satisfies FromWorker);
  });
}
