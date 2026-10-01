import { type ApiError, UPLOAD_MAX_BYTES } from "@majhi/shared";
import { Hono } from "hono";
import { errorMessage, UserError } from "../errors.ts";
import { isLoopbackOrigin } from "../http/origin.ts";
import type { UploadStore } from "./store.ts";

/** `POST /api/uploads`: multipart, field `file`, answered with the `Attachment`. Same Origin rule as commands. */
export function uploadRoutes(store: UploadStore): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return c.json({ error: "Uploads only come from majhi's own pages" } satisfies ApiError, 403);
    }
    const length = Number(c.req.header("content-length") ?? "0");
    // The multipart envelope adds a little to the file, so allow a small margin before reading anything.
    if (length > UPLOAD_MAX_BYTES + 64 * 1024) {
      return c.json(
        { error: `Files can be at most ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.` } satisfies ApiError,
        413,
      );
    }
    let body: Record<string, string | File | (string | File)[]>;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json(
        { error: 'Send the file as multipart form data, in the field "file".' } satisfies ApiError,
        400,
      );
    }
    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ error: 'Send the file in the form field "file".' } satisfies ApiError, 400);
    }
    try {
      const attachment = await store.save({
        name: file.name,
        mime: file.type,
        data: new Uint8Array(await file.arrayBuffer()),
      });
      return c.json(attachment);
    } catch (err) {
      if (err instanceof UserError) {
        return c.json({ error: err.message } satisfies ApiError, file.size > UPLOAD_MAX_BYTES ? 413 : 400);
      }
      return c.json({ error: errorMessage(err) } satisfies ApiError, 500);
    }
  });
  return app;
}
