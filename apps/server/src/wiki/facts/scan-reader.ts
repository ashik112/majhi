import { WIKI_HTTP_METHODS, type WikiEntry } from "@majhi/shared";
import { endpointId, isLoopbackHost } from "../system/address.ts";
import type { CallRow, EntryRow, ReaderOutput, RouteRow } from "./reader-output.ts";
import type { FactSink } from "./sink.ts";

/**
 * Facts from what the sealed reader found in code (`reader.json`): HTTP routes and sockets from Noir, queue consumers,
 * timers and commands from the entry pass, and the addresses the code calls. The reader reports where; this turns each
 * place into a fact, folds the duplicates, and leaves out what is not part of the repo's own running system.
 */

/** Noir's technologies that are not a route the repo serves: page routers, API descriptions, proxy and gateway config. */
const NOT_ROUTES: ReadonlySet<string> = new Set([
  "ts_tanstack_router",
  "oas2",
  "oas3",
  "asyncapi",
  "openrpc",
  "raml",
  "smithy",
  "typespec",
  "wsdl",
  "odata",
  "graphql_sdl",
  "postman",
  "insomnia",
  "bruno",
  "burp",
  "caido",
  "har",
  "http_file",
  "mitmproxy",
  "zap_sites_tree",
  "nginx",
  "apache_httpd",
  "caddy",
  "kong",
  "envoy",
  "traefik",
  "istio_virtualservice",
  "k8s_ingress",
  "k8s_gateway_api",
  "apisix",
  "kamal",
  "android",
  "ios",
  "well_known_applinks",
]);

const SPEC_EXTENSIONS: readonly string[] = [".json", ".yaml", ".yml"];
/** Every method a catch-all route answers. A route Noir lists for all of them is one `ANY` route. */
const ALL_METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const segmentsOf = (path: string): string[] => path.split("/").filter((s) => s !== "");

/** Whether a file is part of the repo's code: not an API description, and not under a hidden folder (agent skills, CI, editor config). */
function isCode(file: string): boolean {
  if (SPEC_EXTENSIONS.some((ext) => file.endsWith(ext))) return false;
  return !file
    .split("/")
    .slice(0, -1)
    .some((part) => part.startsWith(".") || part === "skills");
}

interface Route {
  method: string;
  path: string;
  file: string;
  line: number;
}

/** Whether `longer` ends with all the segments of `shorter` and has more: the same route under a bigger mount. */
function isMountOf(shorter: string[], longer: string[]): boolean {
  if (shorter.length === 0 || shorter.length >= longer.length) return false;
  const tail = longer.slice(longer.length - shorter.length);
  return shorter.every((seg, i) => seg === tail[i]);
}

/**
 * HTTP routes with the repo's own and duplicate rows taken out. Rows for every method of one path on one line are one
 * `ANY` route. Rows on the same line and method whose paths differ only by a mount prefix (`/api/v1/items` and
 * `/oms/api/v1/items`, a router included twice) are one route, shown by its shortest path. Chained routes on one
 * line (`/a` and `/b`) are different routes and stay.
 */
export function foldRoutes(rows: readonly RouteRow[]): { routes: Route[]; folded: number; sockets: Route[] } {
  const kept: Route[] = [];
  const sockets: Route[] = [];
  for (const row of rows) {
    if (!isCode(row.file)) continue;
    if (row.techs.length > 0 && row.techs.every((t) => NOT_ROUTES.has(t))) continue;
    const route = { method: row.method.toUpperCase(), path: row.path, file: row.file, line: row.line };
    if (row.protocol === "ws" || row.protocol === "wss") sockets.push(route);
    else if (row.protocol === "http") kept.push(route);
  }

  const places = new Map<string, Route[]>();
  for (const r of kept) places.set(`${r.file}:${r.line}`, [...(places.get(`${r.file}:${r.line}`) ?? []), r]);

  let folded = 0;
  const out: Route[] = [];
  for (const group of places.values()) {
    const methodsOf = new Map<string, Set<string>>();
    for (const r of group) methodsOf.set(r.path, new Set([...(methodsOf.get(r.path) ?? []), r.method]));
    const shaped: Route[] = [];
    for (const [path, methods] of methodsOf) {
      const first = group[0] as Route;
      if (ALL_METHODS.every((m) => methods.has(m))) {
        folded += methods.size - 1;
        shaped.push({ ...first, path, method: "ANY" });
      } else {
        for (const method of methods) shaped.push({ ...first, path, method });
      }
    }
    const byLength = shaped.toSorted((a, b) => segmentsOf(a.path).length - segmentsOf(b.path).length);
    const taken: Route[] = [];
    for (const r of byLength) {
      const segs = segmentsOf(r.path);
      if (taken.some((t) => t.method === r.method && isMountOf(segmentsOf(t.path), segs))) folded += 1;
      else taken.push(r);
    }
    out.push(...taken);
  }
  return {
    routes: out.toSorted(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method),
    ),
    folded,
    sockets,
  };
}

function schedule(text: string): string {
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) ? `every ${n} seconds` : text;
}

function entryOf(row: EntryRow): WikiEntry | undefined {
  const handler = row.handler ?? undefined;
  const withHandler = handler === undefined ? {} : { handler };
  switch (row.type) {
    case "timer":
      return row.schedule ? { type: "timer", schedule: schedule(row.schedule), ...withHandler } : undefined;
    case "queue":
    case "command":
    case "socket":
      return row.name ? { type: row.type, name: row.name, ...withHandler } : undefined;
  }
}

function entrySlug(entry: WikiEntry, file: string, line: number): string {
  const what =
    entry.type === "http"
      ? `${entry.method}-${entry.path}`
      : entry.type === "timer"
        ? entry.schedule
        : entry.name;
  return `${entry.type}-${what}@${file}:${line}`;
}

export interface ReaderFacts {
  folded: number;
  routes: number;
}

/** Adds the facts of the reader's output to the sink. */
export function addReaderFacts(sink: FactSink, out: ReaderOutput): ReaderFacts {
  const { routes, folded, sockets } = foldRoutes(out.routes);
  const add = (entry: WikiEntry, file: string, line: number) =>
    sink.add({
      kind: "entry",
      entry,
      basis: "declared",
      slug: entrySlug(entry, file, line),
      cites: [{ path: file, lines: [line, line] }],
    });
  for (const r of routes) {
    const method = WIKI_HTTP_METHODS.find((m) => m === r.method) ?? "ANY";
    add({ type: "http", method, path: r.path }, r.file, r.line);
  }
  for (const s of sockets) add({ type: "socket", name: s.path }, s.file, s.line);
  for (const row of out.entries) {
    const entry = entryOf(row);
    if (entry !== undefined) add(entry, row.file, row.line);
  }
  for (const call of out.calls) addCall(sink, call);
  return { folded, routes: routes.length };
}

function addCall(sink: FactSink, call: CallRow): void {
  const host = call.host.toLowerCase();
  const port = call.port ?? undefined;
  const local = isLoopbackHost(host);
  // A local address with no port says nothing about where it leads.
  if (local && port === undefined) return;
  const scope = local ? sink.repo : undefined;
  sink.add({
    kind: "endpoint",
    host,
    ...(port === undefined ? {} : { port }),
    ...(scope === undefined ? {} : { scope }),
    keys: call.key ? [call.key] : [],
    basis: "declared",
    slug: endpointId(host, port, scope),
    cites: [{ path: call.file, lines: [call.line, call.line] }],
  });
}
