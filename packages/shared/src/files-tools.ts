import { z } from "zod";

/**
 * The inputs of majhi's `files` tools (`majhi-files`): how a read-only session reads a repo's export when its agent
 * has no read tool of its own (Codex reads with shell commands, which a read-only session refuses). A path is
 * relative to the session's folder or absolute, and must lie inside the folders the session may read.
 */
const PathSchema = z.string().min(1).max(4_000);

export const FilesReadInputSchema = z.object({
  path: PathSchema.describe("The file to read: relative to your folder, or absolute"),
  first_line: z.number().int().min(1).optional().describe("The first line to read (default 1)"),
  line_count: z.number().int().min(1).max(2_000).optional().describe("How many lines to read (default 400)"),
});
export type FilesReadInput = z.infer<typeof FilesReadInputSchema>;

export const FilesListInputSchema = z.object({
  path: PathSchema.optional().describe("The folder to list (default: your folder)"),
});
export type FilesListInput = z.infer<typeof FilesListInputSchema>;

export const FilesSearchInputSchema = z.object({
  text: z.string().min(1).max(500).describe("Literal text to find, not a pattern"),
  path: PathSchema.optional().describe("A folder or file to search under (default: your folder)"),
  case_sensitive: z.boolean().optional().describe("Match case (default false)"),
});
export type FilesSearchInput = z.infer<typeof FilesSearchInputSchema>;
