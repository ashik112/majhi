import { z } from "zod";

/**
 * What the viewer's Download menu asks the file URL for (`?download=<format>`): the file as it is, or
 * a markdown file exported as one page, PDF or Word document.
 */
export const DownloadFormatSchema = z.enum(["raw", "html", "pdf", "docx"]);
export type DownloadFormat = z.infer<typeof DownloadFormatSchema>;

/** Markdown bigger than this downloads raw only: twice what the viewer renders, and seconds of work already. */
export const EXPORT_SOURCE_LIMIT = 2 * 1024 * 1024;

/** The name a download gets: the source file's name, with the new extension for an export. */
export function downloadName(path: string, format: DownloadFormat): string {
  const name = path.split("/").pop() || "file";
  if (format === "raw") return name;
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.${format}`;
}

/** The URL that downloads a file in a format, from the file's own URL (`taskFileUrl`, `repoFileUrl`, `wikiFileUrl`). */
export function downloadUrl(fileUrl: string, format: DownloadFormat): string {
  return `${fileUrl}?download=${format}`;
}
