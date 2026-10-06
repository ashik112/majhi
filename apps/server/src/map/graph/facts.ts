import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  endpointId,
  GRAPHIFY_FACTS_FILE,
  GraphifyFactsSchema,
  isLoopbackHost,
  type MapEndpoint,
} from "@majhi/shared";
import { hideSecrets } from "../code.ts";
import { lineText } from "../config/located.ts";
import type { ProjectFiles } from "../files.ts";

/** Most addresses one project adds, so a generated client cannot flood the map. */
const ENDPOINTS_MAX = 100;

/**
 * The addresses HTTP client calls use in one project, from the reader's facts (`majhi-facts.json`). Each
 * becomes an endpoint with the line of the file as proof, like the config pass's: whether it is a line to
 * another project is decided by the same resolver (a compose service name, or the owner's answer), never
 * here. An address nobody owns stays in Addresses for the owner to answer. Returns undefined when the
 * file is missing or not in the shape this version writes.
 */
export async function graphEndpoints(
  folder: string,
  project: string,
  files: ProjectFiles,
): Promise<MapEndpoint[] | undefined> {
  let facts: ReturnType<typeof GraphifyFactsSchema.safeParse>;
  try {
    facts = GraphifyFactsSchema.safeParse(
      JSON.parse(await readFile(join(folder, GRAPHIFY_FACTS_FILE), "utf8")),
    );
  } catch {
    return undefined;
  }
  if (!facts.success) return undefined;
  const byId = new Map<string, MapEndpoint>();
  const texts = new Map<string, string | undefined>();
  for (const call of facts.data.calls) {
    const host = call.host.toLowerCase();
    const port = call.port ?? undefined;
    const scope = isLoopbackHost(host) ? project : undefined;
    const id = endpointId(host, port, scope);
    if (!byId.has(id) && byId.size >= ENDPOINTS_MAX) continue;
    if (!texts.has(call.file)) texts.set(call.file, await files.read(call.file));
    const text = texts.get(call.file);
    // The line must still be there as the reader saw it; a file that changed since shows nothing as proof.
    if (text === undefined) continue;
    const excerpt = hideSecrets(lineText(text, call.line));
    if (excerpt === "") continue;
    const ref = {
      project,
      file: call.file,
      line: call.line,
      excerpt,
      key: (call.key ?? call.client).slice(0, 120),
      source: "graph" as const,
      confidence: call.how === "literal" ? ("extracted" as const) : ("inferred" as const),
    };
    const had = byId.get(id);
    if (had === undefined) {
      byId.set(id, {
        id,
        host,
        ...(port === undefined ? {} : { port }),
        ...(scope === undefined ? {} : { scope }),
        refs: [ref],
      });
    } else if (had.refs.length < 12 && !had.refs.some((r) => r.file === ref.file && r.line === ref.line)) {
      had.refs.push(ref);
    }
  }
  return [...byId.values()];
}
