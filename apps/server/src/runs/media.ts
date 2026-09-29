import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaBlock } from "@majhi/acp";
import { type MediaRef, mediaKindOfPath, taskFileUrl } from "@majhi/shared";

/** Images bigger than this are not saved. */
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;

/** Only these image types are saved to the task folder. */
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/** What the room mapper needs to turn ACP media blocks into `MediaRef`s. */
export interface MediaSink {
  image(mime: string, base64: string): MediaRef | undefined;
  link(block: Extract<MediaBlock, { kind: "link" }>): MediaRef | undefined;
}

/**
 * Saves images into `<task folder>/media/<n>.<ext>` and points at them through the task files
 * endpoint. Links to files inside the folder become endpoint URLs too; a link to anything else on
 * this machine is dropped, and only http(s) links stay as they are.
 */
export function taskMediaSink(taskId: string, folder: string): MediaSink {
  const root = resolve(folder);
  return {
    image(mime, base64) {
      const ext = IMAGE_EXT[mime.toLowerCase()];
      if (ext === undefined) return undefined;
      const data = Buffer.from(base64, "base64");
      if (data.byteLength === 0 || data.byteLength > MEDIA_MAX_BYTES) return undefined;
      const dir = join(root, "media");
      mkdirSync(dir, { recursive: true });
      const taken = new Set(readdirSync(dir));
      let n = 1;
      while (taken.has(`${n}.${ext}`)) n += 1;
      const name = `${n}.${ext}`;
      writeFileSync(join(dir, name), data);
      return { kind: "image", name, src: taskFileUrl(taskId, `media/${name}`), mime };
    },
    link(block) {
      const mime = block.mime === undefined ? {} : { mime: block.mime };
      if (/^https?:\/\//i.test(block.uri)) {
        const kind = mediaKindOfPath(new URL(block.uri).pathname);
        return {
          kind: kind === "file" || kind === "page" ? "link" : kind,
          name: block.name,
          src: block.uri,
          ...mime,
        };
      }
      if (block.uri.startsWith("file://")) {
        let path: string;
        try {
          path = resolve(fileURLToPath(block.uri));
        } catch {
          return undefined;
        }
        const rel = relative(root, path);
        if (rel === "" || rel.startsWith("..") || rel.split(sep).some((s) => s.startsWith(".")))
          return undefined;
        const name = block.name === block.uri ? (rel.split(sep).pop() ?? rel) : block.name;
        return {
          kind: mediaKindOfPath(rel),
          name,
          src: taskFileUrl(taskId, rel.split(sep).join("/")),
          ...mime,
        };
      }
      return undefined;
    },
  };
}
