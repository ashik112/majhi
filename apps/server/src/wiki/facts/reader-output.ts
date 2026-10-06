import { CallPathSchema, RepoPathSchema } from "@majhi/shared";
import { z } from "zod";

/**
 * What `docker/wiki_facts.py` writes to `reader.json` in the cache folder. It is the one file the sealed reader hands
 * back, so it is checked here: a row that does not fit is counted and left out, and nothing in it is trusted as a
 * path until `RepoPathSchema` and the export's own containment have looked at it. Names, paths and line numbers only.
 */

export const READER_VERSION = 1;

const Line = z.number().int().positive();

export const RouteRowSchema = z.object({
  method: z.string().min(1).max(20),
  path: z.string().min(1).max(400),
  file: RepoPathSchema,
  line: Line,
  /** Noir's `protocol`: `http`, `ws`, `cli`. */
  protocol: z.string().max(20),
  /** The frameworks Noir named for the route (`python_fastapi`, `js_hono`). */
  techs: z.array(z.string().max(60)).max(12),
});
export type RouteRow = z.infer<typeof RouteRowSchema>;

export const EntryRowSchema = z.object({
  type: z.enum(["queue", "timer", "command", "socket"]),
  file: RepoPathSchema,
  line: Line,
  handler: z.string().max(200).nullish(),
  name: z.string().max(200).nullish(),
  schedule: z.string().max(200).nullish(),
});
export type EntryRow = z.infer<typeof EntryRowSchema>;

export const CallRowSchema = z.object({
  file: RepoPathSchema,
  line: Line,
  scheme: z.string().max(10),
  host: z.string().min(1).max(200),
  port: z.number().int().positive().max(65535).nullish(),
  /** The environment variable the address was the default of, when it was. */
  key: z.string().max(120).nullish(),
});
export type CallRow = z.infer<typeof CallRowSchema>;

/** One HTTP call with its method and path. Names the address only when the call writes one; a path is checked again here before it can become a fact. */
export const RequestRowSchema = z.object({
  file: RepoPathSchema,
  line: Line,
  method: z.string().min(1).max(20),
  path: CallPathSchema,
  host: z.string().min(1).max(200).nullish(),
  port: z.number().int().positive().max(65535).nullish(),
});
export type RequestRow = z.infer<typeof RequestRowSchema>;

const Header = z.object({
  v: z.literal(READER_VERSION),
  files: z.number().int().nonnegative(),
  errors: z.array(z.string().max(400)).max(40),
  routes: z.array(z.unknown()),
  entries: z.array(z.unknown()),
  calls: z.array(z.unknown()),
  requests: z.array(z.unknown()).default([]),
});

export interface ReaderOutput {
  files: number;
  routes: RouteRow[];
  entries: EntryRow[];
  calls: CallRow[];
  requests: RequestRow[];
  /** What each tool said when it failed, and rows left out because they did not fit. */
  errors: string[];
}

function rows<T>(items: readonly unknown[], schema: z.ZodType<T>, what: string, errors: string[]): T[] {
  const out: T[] = [];
  let bad = 0;
  for (const item of items) {
    const got = schema.safeParse(item);
    if (got.success) out.push(got.data);
    else bad += 1;
  }
  if (bad > 0) errors.push(`${bad} ${what} rows did not fit and were left out`);
  return out;
}

/** Parses `reader.json`. Throws when the file is not the reader's (wrong version, not JSON); a bad row is only counted. */
export function parseReaderOutput(text: string): ReaderOutput {
  const head = Header.parse(JSON.parse(text));
  const errors = [...head.errors];
  return {
    files: head.files,
    routes: rows(head.routes, RouteRowSchema, "route", errors),
    entries: rows(head.entries, EntryRowSchema, "entry", errors),
    calls: rows(head.calls, CallRowSchema, "call", errors),
    requests: rows(head.requests, RequestRowSchema, "request", errors),
    errors,
  };
}
