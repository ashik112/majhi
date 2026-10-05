import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { isInside } from "../editor/allowed.ts";
import { FETCHED_VALUE_MAX } from "./fetch-secret.ts";

export const CLIPBOARD_COPY_TOOL = "majhi_clipboard_copy";

/** The largest file the tool reads. A key sits in a config file, not in a build output. */
export const CLIPBOARD_FILE_MAX = 1_000_000;

export const ClipboardCopyInputSchema = z
  .object({
    /** A saved secret, by name (the part after `secret:`). */
    secret: z.string().trim().min(1).optional(),
    /** Absolute path of a file in one of this workspace's projects. */
    file: z.string().trim().min(1).max(4096).optional(),
    /** 1-based line of `file`. */
    line: z.number().int().min(1).optional(),
    /**
     * `whole`: the line, trimmed. `value`: what follows the `=` or `:` of a `KEY=value`, `KEY: value` or
     * `export KEY="value"` line, without the quotes and a trailing comment.
     */
    part: z.enum(["whole", "value"]).default("whole"),
    ownerAsked: z.boolean().optional(),
  })
  .refine((v) => (v.secret === undefined) !== (v.file === undefined), "Give a secret, or a file and a line")
  .refine((v) => v.file === undefined || v.line !== undefined, "A file needs a line");
export type ClipboardCopyInput = z.infer<typeof ClipboardCopyInputSchema>;

/** What the server needs of the world to copy: the workspace's project folders and the helper. */
export interface ClipboardCopier {
  /** Absolute folders of the workspace's own projects. Another workspace's never count. */
  roots(org: string): Promise<readonly string[]>;
  /** Whether the host helper is connected. */
  available(): boolean;
  /** True when the helper put `text` on the clipboard. */
  copy(text: string): Promise<boolean>;
}

const KEY_LINE = /^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*(.*)$/;

/** The part of `text`'s `line` to copy, or why there is none. Messages never carry the line's text. */
export function pickValue(
  text: string,
  line: number,
  part: "whole" | "value",
): { value: string } | { problem: string } {
  const raw = text.split(/\r?\n/)[line - 1];
  if (raw === undefined) return { problem: `The file has no line ${line}.` };
  let value = raw.trim();
  if (part === "value") {
    const rest = KEY_LINE.exec(raw)?.[1];
    if (rest === undefined) return { problem: `Line ${line} is not a KEY=value or KEY: value line.` };
    value = unquote(rest.trim());
  }
  if (value === "") return { problem: `Line ${line} is empty, so nothing was copied.` };
  if (value.length > FETCHED_VALUE_MAX) {
    return { problem: `Line ${line} is longer than ${FETCHED_VALUE_MAX} characters, so nothing was copied.` };
  }
  return { value };
}

function unquote(rest: string): string {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    return end === -1 ? rest.slice(1) : rest.slice(1, end);
  }
  // An unquoted value ends at a ` #` comment.
  const comment = rest.search(/\s#/);
  return (comment === -1 ? rest : rest.slice(0, comment)).trim();
}

/**
 * The file's text, when `path` is a regular file inside one of `roots`, links followed. The error
 * says where the problem is, never what the file holds.
 */
export async function readInRoots(
  path: string,
  roots: readonly string[],
): Promise<{ text: string } | { problem: string }> {
  if (!isAbsolute(path) || path.includes("\0")) return { problem: "Give an absolute path." };
  const target = resolve(path);
  const real = await realpath(target).catch(() => undefined);
  if (real === undefined) return { problem: `There is nothing at ${target}.` };
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => resolve(r))));
  if (!realRoots.some((root) => isInside(real, root))) {
    return { problem: `${target} is not in one of this workspace's projects.` };
  }
  const info = await stat(real);
  if (!info.isFile()) return { problem: `${target} is not a file.` };
  if (info.size > CLIPBOARD_FILE_MAX) return { problem: `${target} is too large to take a line from.` };
  return { text: await readFile(real, "utf8") };
}
