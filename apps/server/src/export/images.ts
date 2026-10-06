/** An image the document shows: its bytes and MIME type, read under the viewer's own access rules. */
export interface ImageFile {
  bytes: Buffer;
  type: string;
}

/**
 * Reads an image a document names by its target as written. Undefined when the viewer would not
 * serve it (outside the folder, a hidden name, missing, too big).
 */
export type ImageReader = (target: string) => Promise<ImageFile | undefined>;

/** Images past these sizes stay as their alt text, so one export cannot hold the server's memory. */
export const IMAGE_LIMIT = 10 * 1024 * 1024;
export const IMAGES_TOTAL_LIMIT = 40 * 1024 * 1024;
