import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { FilesListInputSchema, FilesReadInputSchema, FilesSearchInputSchema } from "@majhi/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatIssues } from "../errors.ts";
import { FILES_SERVER_NAME, type FilesScope } from "../rooms/access.ts";
import { containment } from "./read-only.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** Lines a `read` gives when it is not told how many, and the most it gives. */
const DEFAULT_LINES = 400;
/** A `read` answer is cut after this many characters, and a line after `LINE_CHARS`. */
const READ_CHARS = 60_000;
const LINE_CHARS = 2_000;
/** A `list` answer is cut after this many entries. */
const LIST_MAX = 500;
/** A `search` stops at this many hits, files looked at, or seconds, and says so. */
const SEARCH_HITS = 100;
const SEARCH_FILES = 20_000;
const SEARCH_MS = 20_000;
/** A file bigger than this is not searched (a bundle or a dump); it can still be read by lines. */
const SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const HIT_CHARS = 300;
/** A file whose start holds a NUL byte in this many bytes is binary. */
const SNIFF_BYTES = 8 * 1024;

const TOOLS = [
  {
    name: "read",
    description:
      "Read a text file. Answers with numbered lines (the number, a tab, the line) so you can cite real line numbers. Give first_line and line_count to read part of a long file; a cut answer says where to continue.",
    input: FilesReadInputSchema,
  },
  {
    name: "list",
    description: "List the entries of one folder. Folders end with a slash.",
    input: FilesListInputSchema,
  },
  {
    name: "search",
    description:
      "Find literal text (not a pattern) in the files under a folder. Answers path:line: text, up to 100 hits. Binary and very large files are skipped.",
    input: FilesSearchInputSchema,
  },
] as const;

const outside = (path: string) => `${path} is outside the folders this session may read.`;

/** The files of a read-only session: three tools, all limited to `scope` by the same containment as its permission rule. */
export function filesServer(scope: FilesScope): Server {
  const server = new Server({ name: FILES_SERVER_NAME, version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => {
      const { $schema: _dropped, ...schema } = z.toJSONSchema(t.input, {
        io: "input",
        unrepresentable: "any",
      }) as Record<string, unknown>;
      return {
        name: t.name,
        description: t.description,
        inputSchema: { ...schema, type: "object" as const },
      };
    }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<Result> => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (tool === undefined) return fail(`There is no tool ${request.params.name}.`);
    const parsed = tool.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return fail(`Invalid arguments:\n${formatIssues(parsed.error).join("\n")}`);
    try {
      switch (tool.name) {
        case "read":
          return await readFileLines(scope, FilesReadInputSchema.parse(parsed.data));
        case "list":
          return await listFolder(scope, FilesListInputSchema.parse(parsed.data));
        case "search":
          return await searchText(scope, FilesSearchInputSchema.parse(parsed.data));
      }
    } catch (err) {
      return fail(`${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return server;
}

/** Where `path` really is, when it is a thing this session may read. */
async function placeOf(scope: FilesScope, path: string): Promise<{ real: string } | Result> {
  const where = await containment(path, scope.root, scope.also);
  if (!where.inside) return fail(outside(path));
  if (!where.exists) return fail(`${path} does not exist.`);
  return { real: where.real };
}

const isResult = (v: { real: string } | Result): v is Result => "content" in v;

async function isBinary(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function cutLine(line: string, chars: number): string {
  return line.length <= chars ? line : `${line.slice(0, chars)} [line cut]`;
}

/** `cat -n`: the number right-aligned in 6 columns, a tab, the line. */
function numbered(n: number, line: string): string {
  return `${String(n).padStart(6)}\t${line}`;
}

async function readFileLines(
  scope: FilesScope,
  input: z.infer<typeof FilesReadInputSchema>,
): Promise<Result> {
  const place = await placeOf(scope, input.path);
  if (isResult(place)) return place;
  if (!(await stat(place.real)).isFile()) return fail(`${input.path} is not a file. Use list for a folder.`);
  if (await isBinary(place.real)) return fail(`${input.path} is a binary file.`);
  const first = input.first_line ?? 1;
  const last = first + (input.line_count ?? DEFAULT_LINES) - 1;
  const out: string[] = [];
  let chars = 0;
  let seen = 0;
  let stoppedAt: number | undefined;
  const stream = createReadStream(place.real, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      seen++;
      if (seen < first) continue;
      if (seen > last || chars >= READ_CHARS) {
        stoppedAt = seen;
        break;
      }
      const text = numbered(seen, cutLine(line, LINE_CHARS));
      chars += text.length + 1;
      out.push(text);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (out.length === 0) {
    return ok(
      seen === 0
        ? "The file is empty."
        : `The file has only ${seen} lines, so nothing starts at line ${first}.`,
    );
  }
  if (stoppedAt !== undefined)
    out.push(`[Cut here: more lines follow. Continue with first_line ${stoppedAt}.]`);
  return ok(out.join("\n"));
}

async function listFolder(scope: FilesScope, input: z.infer<typeof FilesListInputSchema>): Promise<Result> {
  const place = await placeOf(scope, input.path ?? ".");
  if (isResult(place)) return place;
  if (!(await stat(place.real)).isDirectory()) return fail(`${input.path ?? "."} is not a folder.`);
  const entries = (await readdir(place.real, { withFileTypes: true }))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  if (entries.length === 0) return ok("The folder is empty.");
  const shown = entries.slice(0, LIST_MAX);
  if (entries.length > shown.length) shown.push(`[${entries.length - shown.length} more entries not shown.]`);
  return ok(shown.join("\n"));
}

async function searchText(scope: FilesScope, input: z.infer<typeof FilesSearchInputSchema>): Promise<Result> {
  const where = input.path ?? ".";
  const place = await placeOf(scope, where);
  if (isResult(place)) return place;
  const exact = input.case_sensitive === true;
  const needle = exact ? input.text : input.text.toLowerCase();
  // Hits name files the way the agent named the place it searched, not by the real path of a folder it was given a link to.
  const shown = resolve(scope.root, where);
  const hits: string[] = [];
  let files = 0;
  let cut: string | undefined;
  const deadline = Date.now() + SEARCH_MS;

  const searchFile = async (real: string): Promise<void> => {
    files++;
    if ((await stat(real)).size > SEARCH_FILE_BYTES || (await isBinary(real))) return;
    const rows = (await readFile(real, "utf8")).split("\n");
    for (let i = 0; i < rows.length && hits.length < SEARCH_HITS; i++) {
      const raw = rows[i] ?? "";
      const row = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if ((exact ? row : row.toLowerCase()).includes(needle)) {
        hits.push(`${join(shown, relative(place.real, real))}:${i + 1}: ${cutLine(row.trim(), HIT_CHARS)}`);
      }
    }
  };

  /** Why the search must stop now, when it must. */
  const limit = (): string | undefined => {
    if (hits.length >= SEARCH_HITS) return `Stopped at ${SEARCH_HITS} hits.`;
    if (files >= SEARCH_FILES) return `Stopped after ${SEARCH_FILES} files.`;
    if (Date.now() > deadline) return `Stopped after ${SEARCH_MS / 1000} seconds.`;
    return undefined;
  };

  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const e of entries) {
      cut ??= limit();
      if (cut !== undefined) return;
      // A link is never followed: where it leads is not what the walk was asked to search.
      if (e.isSymbolicLink()) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) await searchFile(path).catch(() => undefined);
    }
  };

  if ((await stat(place.real)).isDirectory()) await walk(place.real);
  else await searchFile(place.real);
  cut ??= limit();
  if (hits.length === 0) return ok(cut === undefined ? "No matches." : `No matches. ${cut}`);
  return ok([...hits, ...(cut === undefined ? [] : [`[${cut}]`])].join("\n"));
}
