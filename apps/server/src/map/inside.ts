import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  GRAPHIFY_FACTS_FILE,
  type GraphifyFacts,
  GraphifyFactsSchema,
  type InsideData,
  type InsideSpec,
  type InsideTrigger,
  isLoopbackHost,
} from "@majhi/shared";
import { outsideOfHost } from "./config/known.ts";

/** Datastores the config pass names on a project's card. */
export const STORE_LABELS: ReadonlySet<string> = new Set([
  "Postgres",
  "MySQL",
  "MongoDB",
  "Redis",
  "RabbitMQ",
  "Kafka",
  "NATS",
  "Memcached",
  "Elasticsearch",
  "ClickHouse",
  "SQLite",
]);

/** Functions the page shows for one project, and how far from an entry point it follows calls. */
const FNS_MAX = 60;
const DEPTH_MAX = 4;

export interface InsideContext {
  project: string;
  /** Datastores from the project's config (its Postgres chip), shown even when no function was seen using one. */
  dbs: readonly string[];
  /** Compose services this project builds, by name. Empty: functions are grouped by what starts them. */
  services: readonly string[];
  /** Who owns an address a function calls: another project of the workspace, an outside service, or nobody. */
  owner: (
    host: string,
    port: number | undefined,
  ) => { kind: "proj"; name: string } | { kind: "out"; name: string } | undefined;
}

const OUT_SUB: Readonly<Record<string, string>> = {
  Stripe: "payments",
  OpenAI: "AI model",
  Anthropic: "AI model",
  Telegram: "bot API",
  "Hacker News": "front page",
  Exa: "web search",
  Firecrawl: "page scraping",
  GitHub: "code hosting",
  Slack: "messages",
  Sentry: "error reports",
  Twilio: "SMS and calls",
  SendGrid: "email",
  Resend: "email",
  Replicate: "AI models",
};

/** A short stable id of an entry point: the same kind, label and file give the same id. */
export function entryId(kind: string, label: string, file: string): string {
  let h = 5381;
  for (const ch of `${kind}|${label}|${file}`) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return `${kind.slice(0, 1).toLowerCase()}${h.toString(36)}`;
}

/** Names of the services the entry kinds are most likely to run in, tried in order against compose service names. */
const SERVICE_HINTS: Record<InsideTrigger, readonly string[]> = {
  HTTP: ["api", "web", "app", "server", "backend"],
  SCHEDULE: ["beat", "sched", "cron"],
  QUEUE: ["worker", "consumer", "celery", "queue"],
  COMMAND: ["cli", "job", "task", "command"],
};
const DEFAULT_SERVICE: Record<InsideTrigger, string> = {
  HTTP: "api",
  SCHEDULE: "scheduler",
  QUEUE: "worker",
  COMMAND: "commands",
};

function serviceFor(kind: InsideTrigger, services: readonly string[]): string {
  for (const hint of SERVICE_HINTS[kind]) {
    const hit = services.find((s) => s.toLowerCase().includes(hint));
    if (hit !== undefined) return hit;
  }
  return services.length === 1 ? (services[0] as string) : DEFAULT_SERVICE[kind];
}

/**
 * The Inside spec of a project from its facts file: the entry points, the functions they reach (calls
 * followed up to four deep, at most 60 shown), and the data and outside services those functions use.
 * Undefined when the facts do not carry the inside part (the project was read before it existed).
 */
export function buildInside(facts: GraphifyFacts, ctx: InsideContext): InsideSpec | undefined {
  const inside = facts.inside;
  if (inside === undefined) return undefined;
  const entries = inside.entries.map((e) => ({ ...e, id: entryId(e.kind, e.label, e.file) }));
  const uniqueEntries = [...new Map(entries.map((e) => [e.id, e])).values()];

  // Which function each entry starts, and how far every function is from the nearest entry.
  const out = new Map<string, string[]>();
  for (const c of inside.calls) out.set(c.from, [...(out.get(c.from) ?? []), c.to]);
  const depth = new Map<string, number>();
  const kindOf = new Map<string, InsideTrigger>();
  let frontier: string[] = [];
  for (const e of uniqueEntries) {
    if (!depth.has(e.fn)) {
      depth.set(e.fn, 0);
      kindOf.set(e.fn, e.kind);
      frontier.push(e.fn);
    }
  }
  for (let d = 1; d <= DEPTH_MAX && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const fn of frontier) {
      for (const to of out.get(fn) ?? []) {
        if (depth.has(to)) continue;
        depth.set(to, d);
        kindOf.set(to, kindOf.get(fn) as InsideTrigger);
        next.push(to);
      }
    }
    frontier = next;
  }
  const defs = new Map(inside.defs.map((d) => [d.id, d]));
  const ranked = [...depth.entries()]
    .filter(([id]) => defs.has(id))
    .toSorted((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const shown = new Set(ranked.slice(0, FNS_MAX).map(([id]) => id));
  const fns = ranked
    .slice(0, FNS_MAX)
    .map(([id]) => {
      const d = defs.get(id) as (typeof inside.defs)[number];
      return {
        id,
        file: d.file,
        line: d.line,
        doc: d.doc,
        service: serviceFor(kindOf.get(id) as InsideTrigger, ctx.services),
      };
    })
    .toSorted(
      (a, b) => a.service.localeCompare(b.service) || a.file.localeCompare(b.file) || a.line - b.line,
    );

  // Data: what the functions use through a client library, and what they call over HTTP.
  const data = new Map<string, InsideData>();
  const uses: InsideSpec["uses"] = [];
  const fileOf = (fn: string) => defs.get(fn)?.file ?? "";
  const addUse = (
    fn: string,
    d: InsideData,
    file: string,
    line: number,
    verb: InsideSpec["uses"][number]["verb"],
  ) => {
    data.set(d.id, d);
    if (!uses.some((u) => u.fn === fn && u.data === d.id)) uses.push({ fn, data: d.id, file, line, verb });
  };
  for (const u of inside.uses) {
    if (!shown.has(u.fn)) continue;
    const id = u.kind === "db" ? `db:${u.name}:${u.target ?? ""}` : `out:${u.name}`;
    const name = u.kind === "db" ? (u.target ?? u.name) : u.name;
    const sub =
      u.kind === "db"
        ? u.target === undefined
          ? "datastore"
          : `${u.name} table`
        : (OUT_SUB[u.name] ?? "outside service");
    addUse(u.fn, { id, kind: u.kind, name, sub }, fileOf(u.fn), u.line, u.verb);
  }
  const byFile = new Map<string, (typeof inside.defs)[number][]>();
  for (const d of inside.defs) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);
  for (const call of facts.calls) {
    if (isLoopbackHost(call.host)) continue;
    const owner = ctx.owner(call.host, call.port ?? undefined) ?? {
      kind: "out" as const,
      name: outsideOfHost(call.host)?.label ?? call.host,
    };
    const inner = (byFile.get(call.file) ?? [])
      .filter((d) => d.line <= call.line && call.line <= d.end)
      .toSorted((a, b) => a.end - a.line - (b.end - b.line))[0];
    if (inner === undefined || !shown.has(inner.id)) continue;
    const d: InsideData =
      owner.kind === "proj"
        ? { id: `proj:${owner.name}`, kind: "proj", name: owner.name, sub: "project" }
        : {
            id: `out:${owner.name}`,
            kind: "out",
            name: owner.name,
            sub: OUT_SUB[owner.name] ?? "outside service",
          };
    addUse(inner.id, d, call.file, call.line, "call");
  }

  const calls = inside.calls
    .filter((c) => shown.has(c.from) && shown.has(c.to))
    .map((c) => ({ from: c.from, to: c.to, file: fileOf(c.from), line: c.line }));
  const dbs = [
    ...new Set([
      ...ctx.dbs,
      ...[...data.values()].filter((d) => d.kind === "db").map((d) => d.sub.split(" ")[0] as string),
    ]),
  ].filter((d) => d !== "datastore");
  const services = [...new Set(fns.map((f) => f.service))];
  return {
    v: 1,
    project: ctx.project,
    entries: uniqueEntries
      .filter((e) => shown.has(e.fn))
      .map(({ id, kind, label, file, line, fn }) => ({ id, kind, label, file, line, fn })),
    fns,
    data: [...data.values()],
    calls,
    uses,
    services,
    dbs: dbs.slice(0, 20),
    hidden: Math.max(0, ranked.length - FNS_MAX),
  };
}

/** Reads and checks a project's facts file. Undefined when it is missing or not in a shape this version knows. */
export async function readFacts(
  folder: string,
): Promise<{ facts: GraphifyFacts; stamp: number } | undefined> {
  try {
    const file = join(folder, GRAPHIFY_FACTS_FILE);
    const [raw, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const parsed = GraphifyFactsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { facts: parsed.data, stamp: info.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}
