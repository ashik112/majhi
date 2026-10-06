import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  GRAPHIFY_FACTS_FILE,
  type GraphifyFacts,
  GraphifyFactsSchema,
  type InsideData,
  type InsideEntry,
  type InsideMoreEntry,
  type InsideSpec,
  type InsideStepSpec,
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

/** Entry points drawn on the canvas; the rest wait under "Show more". */
export const ENTRIES_SHOWN = 10;
/** Functions the canvas draws for one project. */
const FNS_MAX = 60;
/** Calls followed from an entry's function. */
export const TRACE_DEPTH = 4;
/** Steps kept for one entry point. */
export const TRACE_STEPS = 9;

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

/** A sentence written once by a model, kept by the key of what it is about. */
export interface Words {
  get: (key: string) => string | undefined;
}
export const NO_WORDS: Words = { get: () => undefined };

/** What the words pass sends the model for one sentence. */
export interface WordItem {
  key: string;
  kind: "step" | "group";
  part: string;
  /** What this step does in the flow, in words majhi wrote ("starts the flow for GET /x"). */
  role: string;
  file: string;
  line: number;
  end: number;
  /** For a group: the routes, commands or tools in it. */
  members: string[];
  /** For a data step: the name of the data. */
  data?: string;
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

const sha = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 16);

const KIND_RANK: Record<InsideTrigger, number> = {
  HTTP: 0,
  SOCKET: 1,
  TOOL: 2,
  SCHEDULE: 3,
  QUEUE: 4,
  COMMAND: 5,
};

/** Names of the services the entry kinds are most likely to run in, tried in order against compose service names. */
const SERVICE_HINTS: Record<InsideTrigger, readonly string[]> = {
  HTTP: ["api", "web", "app", "server", "backend"],
  SOCKET: ["api", "web", "app", "server", "backend"],
  TOOL: ["api", "app", "server", "backend", "mcp"],
  SCHEDULE: ["beat", "sched", "cron"],
  QUEUE: ["worker", "consumer", "celery", "queue"],
  COMMAND: ["cli", "job", "task", "command"],
};
const DEFAULT_SERVICE: Record<InsideTrigger, string> = {
  HTTP: "api",
  SOCKET: "api",
  TOOL: "tools",
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

// ---------------------------------------------------------------------------
// Parts: where in the project a file lives

/** Folders that say where code sits, not what it is about. They are skipped when naming a part. */
const GENERIC_DIRS: ReadonlySet<string> = new Set([
  "apps",
  "app",
  "packages",
  "src",
  "lib",
  "server",
  "backend",
  "frontend",
  "api",
  "routes",
  "routers",
  "endpoints",
  "v1",
  "v2",
  "pages",
  "internal",
  "cmd",
  "pkg",
  "core",
  "handlers",
  "controllers",
  "features",
  "modules",
]);

const capital = (word: string): string => word.slice(0, 1).toUpperCase() + word.slice(1);

/** The part of the project a file belongs to: the first folder that is about something, else the file's own name. */
export function partOf(file: string): string {
  const parts = file.split("/");
  const last = (parts.pop() ?? "").split(".")[0] ?? "";
  const segs = [...parts, last].filter((s) => s !== "" && s !== "index");
  const pick = segs.find((s) => !GENERIC_DIRS.has(s)) ?? segs[segs.length - 1] ?? "project";
  const words = pick
    .split("-")
    .flatMap((w) => w.split("_"))
    .filter((w) => w !== "");
  return capital(words.join(" ").toLowerCase());
}

// ---------------------------------------------------------------------------
// Template sentences, used until a model has written better ones

const PHRASE: Readonly<Record<string, string>> = {
  "Hacker News": "reads the Hacker News front page",
  Stripe: "creates a payment with Stripe",
  OpenAI: "sends the request to OpenAI",
  Anthropic: "sends the prompt to Anthropic",
  Telegram: "talks to Telegram",
  GitHub: "reads from GitHub",
  Slack: "posts to Slack",
  Sentry: "reports to Sentry",
  Twilio: "sends through Twilio",
  SendGrid: "sends the email through SendGrid",
  Resend: "sends the email through Resend",
  Exa: "searches the web with Exa",
  Firecrawl: "scrapes the page with Firecrawl",
  Replicate: "runs the model on Replicate",
};

function entryText(kind: InsideTrigger, raw: string): string {
  switch (kind) {
    case "HTTP":
      return `A request to ${raw} arrives.`;
    case "SOCKET":
      return "A live connection opens.";
    case "TOOL":
      return "An agent calls a tool.";
    case "SCHEDULE":
      return `Wakes up ${raw}.`;
    case "QUEUE":
      return `A job for ${raw} arrives.`;
    case "COMMAND":
      return `The command ${raw} starts.`;
  }
}

/** One sentence for several tables of one datastore a step touches. */
function tablesSentence(datas: readonly InsideData[], verbs: ReadonlySet<Use["verb"]>): string {
  const names = datas.map((d) => d.name);
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  const what = datas.every((d) => d.sub.endsWith("table"))
    ? `the ${shown} ${datas.length === 1 ? "table" : "tables"}`
    : shown;
  const read = verbs.has("read");
  const write = verbs.has("write");
  if (read && write) return `Reads from and saves to ${what}.`;
  if (write) return `Saves to ${what}.`;
  if (read) return `Reads from ${what}.`;
  return `Uses ${what}.`;
}

function dataSentence(data: InsideData, verb: "read" | "write" | "call" | "use"): string {
  if (data.kind === "out") {
    const phrase = PHRASE[data.name];
    return phrase === undefined ? `Sends a request to ${data.name}.` : `${capital(phrase)}.`;
  }
  if (data.kind === "proj") return `Hands the work to ${data.name}.`;
  const store = data.sub.endsWith("table") ? `the ${data.name} table` : data.name;
  if (verb === "write") return `Saves to ${store}.`;
  if (verb === "read") return `Reads from ${store}.`;
  return `Uses ${store}.`;
}

// ---------------------------------------------------------------------------
// The trace of one entry point

type Facts = NonNullable<GraphifyFacts["inside"]>;
type Def = Facts["defs"][number];
type Use = Facts["uses"][number];

/** A call is followed only when the code proves it: the callee is in the same file or imported. */
export function provedCalls(inside: Facts): Map<string, { to: string; line: number }[]> {
  const out = new Map<string, { to: string; line: number }[]>();
  for (const c of inside.calls) {
    if (c.how !== "same-file" && c.how !== "import") continue;
    out.set(c.from, [...(out.get(c.from) ?? []), { to: c.to, line: c.line }]);
  }
  return out;
}

function dataOf(u: Use): InsideData {
  const id = u.kind === "db" ? `db:${u.name}:${u.target ?? ""}` : `out:${u.name}`;
  const name = u.kind === "db" ? (u.target ?? u.name) : u.name;
  const sub =
    u.kind === "db"
      ? u.target === undefined
        ? "datastore"
        : `${u.name} table`
      : (OUT_SUB[u.name] ?? "outside service");
  return { id, kind: u.kind, name, sub };
}

interface Traced {
  step: Omit<InsideStepSpec, "text"> & { template: string; item: WordItem };
  data?: InsideData;
  use?: { fn: string; verb: Use["verb"]; line: number; file: string };
  /** A data step that several tables of one datastore share: the rest of them. */
  extra?: { data: InsideData; use: { fn: string; verb: Use["verb"]; line: number; file: string } }[];
  verbs?: Set<Use["verb"]>;
  call?: { from: string; to: string; line: number };
}

/**
 * What happens after an entry point, as steps between parts of the project. A step is a part taking over
 * (the call crosses into another folder) or a part using data (a table, an outside service). Calls inside
 * one part fold into its step, and a trivial helper is not a step. Only proved calls are followed, at most
 * `TRACE_DEPTH` deep, at most `TRACE_STEPS` steps.
 */
function traceOf(
  entry: { kind: InsideTrigger; raw: string; file: string; line: number; fn: string; id: string },
  g: {
    defs: Map<string, Def>;
    calls: Map<string, { to: string; line: number }[]>;
    uses: Map<string, Use[]>;
    project: string;
  },
): Traced[] {
  const lead = g.defs.get(entry.fn);
  const startPart = partOf(lead?.file ?? entry.file);
  const out: Traced[] = [];
  const entryItem: WordItem = {
    key: sha(`${g.project}|e|${entry.id}`),
    kind: "step",
    part: startPart,
    role: `starts the flow for ${entry.raw}`,
    file: lead?.file ?? entry.file,
    line: lead?.line ?? entry.line,
    end: lead?.end ?? entry.line,
    members: [],
  };
  out.push({
    step: {
      key: `i:${entry.id}`,
      kind: "entry",
      template: entryText(entry.kind, entry.raw),
      part: startPart,
      from: entry.raw,
      to: entry.fn,
      file: entry.file,
      line: entry.line,
      fns: [{ id: entry.fn, file: lead?.file ?? entry.file, line: lead?.line ?? entry.line }],
      wordsKey: entryItem.key,
      item: entryItem,
    },
  });
  const visited = new Set<string>([entry.fn]);
  const seenData = new Set<string>();
  const reach = new Map<string, boolean>();
  /** Whether the function, or what it calls (a few deep), uses a datastore or an outside service. */
  const reachesOutput = (fn: string, depth = 3): boolean => {
    const known = reach.get(fn);
    if (known !== undefined) return known;
    reach.set(fn, false);
    const yes =
      (g.uses.get(fn)?.length ?? 0) > 0 ||
      (depth > 0 && (g.calls.get(fn) ?? []).some((c) => reachesOutput(c.to, depth - 1)));
    reach.set(fn, yes);
    return yes;
  };
  const walk = (fn: string, rep: string, repStep: Traced, depth: number) => {
    const items = [
      ...(g.calls.get(fn) ?? []).map((c) => ({ line: c.line, call: c })),
      ...(g.uses.get(fn) ?? []).map((u) => ({ line: u.line, use: u })),
    ].toSorted((a, b) => a.line - b.line);
    for (const item of items) {
      if (out.length >= TRACE_STEPS) return;
      if ("call" in item) {
        const to = item.call.to;
        const d = g.defs.get(to);
        if (d === undefined || visited.has(to) || depth + 1 > TRACE_DEPTH) continue;
        visited.add(to);
        const part = partOf(d.file);
        const last = out[out.length - 1] as Traced;
        if (part === repStep.step.part || (last.step.kind !== "data" && part === last.step.part)) {
          const into = part === repStep.step.part ? repStep : last;
          if (into.step.fns.length < 8) into.step.fns.push({ id: to, file: d.file, line: d.line });
          walk(to, into === repStep ? rep : (into.step.fns[0]?.id ?? rep), into, depth + 1);
          continue;
        }
        // A helper that reaches no data is not a step of the story.
        if (!reachesOutput(to)) continue;
        const key = `c:${rep}>${to}`;
        const wk = sha(`${g.project}|c|${entry.id}|${to}`);
        const next: Traced = {
          step: {
            key,
            kind: "call",
            template: "The work continues here.",
            part,
            from: rep,
            to,
            file: d.file,
            line: d.line,
            fns: [{ id: to, file: d.file, line: d.line }],
            wordsKey: wk,
            item: {
              key: wk,
              kind: "step",
              part,
              role: `is reached from the ${repStep.step.part} part`,
              file: d.file,
              line: d.line,
              end: d.end,
              members: [],
            },
          },
          call: { from: rep, to, line: item.call.line },
        };
        out.push(next);
        walk(to, to, next, depth + 1);
      } else {
        const u = item.use;
        const data = dataOf(u);
        const dk = `${rep}>${data.id}`;
        const usedIn = g.defs.get(fn);
        const useFile = usedIn?.file ?? entry.file;
        if (seenData.has(dk)) {
          // The same table again, maybe with another verb: the step says both.
          const there = out.find(
            (t) =>
              t.use?.fn === rep &&
              (t.data?.id === data.id || t.extra?.some((e) => e.data.id === data.id) === true),
          );
          if (there?.data !== undefined && there.verbs !== undefined && !there.verbs.has(u.verb)) {
            there.verbs.add(u.verb);
            there.step.template = tablesSentence(
              [there.data, ...(there.extra ?? []).map((e) => e.data)],
              there.verbs,
            );
          }
          continue;
        }
        seenData.add(dk);
        const sibling =
          data.kind === "db"
            ? out.find(
                (t) =>
                  t.data?.kind === "db" &&
                  t.use?.fn === rep &&
                  t.data.sub.split(" ")[0] === data.sub.split(" ")[0],
              )
            : undefined;
        if (sibling?.data !== undefined && sibling.verbs !== undefined) {
          sibling.extra = [
            ...(sibling.extra ?? []),
            { data, use: { fn: rep, verb: u.verb, line: u.line, file: useFile } },
          ];
          sibling.verbs.add(u.verb);
          sibling.step.template = tablesSentence(
            [sibling.data, ...sibling.extra.map((e) => e.data)],
            sibling.verbs,
          );
          continue;
        }
        const repDef = g.defs.get(rep);
        const part = data.kind === "db" ? "Database" : data.kind === "proj" ? data.name : data.name;
        const wk = sha(`${g.project}|d|${entry.id}|${dk}`);
        out.push({
          step: {
            key: `d:${rep}>${data.id}`,
            kind: "data",
            template: dataSentence(data, u.verb),
            part,
            from: rep,
            to: data.name,
            file: useFile,
            line: u.line,
            fns: [{ id: fn, file: useFile, line: u.line }],
            wordsKey: wk,
            item: {
              key: wk,
              kind: "step",
              part: repStep.step.part,
              role: `${u.verb === "write" ? "saves to" : u.verb === "read" ? "reads from" : "uses"} ${data.sub.endsWith("table") ? `the ${data.name} table in ` : ""}${data.sub.endsWith("table") ? data.sub.replace(" table", "") : data.name}`,
              file: repDef?.file ?? entry.file,
              line: repDef?.line ?? u.line,
              end: repDef?.end ?? u.line,
              members: [],
              data: data.name,
            },
          },
          data,
          use: { fn: rep, verb: u.verb, line: u.line, file: useFile },
          verbs: new Set([u.verb]),
        });
      }
    }
  };
  walk(entry.fn, entry.fn, out[0] as Traced, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Entry points, grouped by what they are for

interface Group {
  kind: InsideTrigger;
  members: Facts["entries"];
  lead: Facts["entries"][number];
  trace: Traced[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function groupLabel(g: Group): { label: string; raw: string } {
  const first = g.lead;
  const part = partOf(first.file);
  const extra = g.members.length > 1 ? ` +${g.members.length - 1} more` : "";
  if (first.members !== undefined && first.members.length > 0) {
    return { label: `${first.label} · ${first.count ?? first.members.length} handlers`, raw: first.label };
  }
  switch (g.kind) {
    case "HTTP":
      return g.members.length > 1
        ? { label: `${part} requests (${g.members.length})`, raw: `${first.label}${extra}` }
        : { label: first.label, raw: first.label };
    case "SOCKET":
      return { label: `Live connection · ${part}`, raw: first.label };
    case "TOOL":
      return { label: `Agent tools · ${part}`, raw: first.label };
    case "SCHEDULE":
      return { label: `${part}: ${first.label}`, raw: first.label };
    case "QUEUE":
      return { label: `${part}: ${first.label}`, raw: first.label };
    case "COMMAND":
      return g.members.length > 1
        ? { label: `Command-line scripts (${g.members.length})`, raw: `${first.label}${extra}` }
        : { label: first.label, raw: first.label };
  }
}

function groupsOf(entries: Facts["entries"], trace: (e: Facts["entries"][number]) => Traced[]): Group[] {
  const byKey = new Map<string, Facts["entries"]>();
  for (const e of entries) {
    const own = e.members !== undefined && e.members.length > 0;
    const key =
      own || e.kind === "SCHEDULE" || e.kind === "QUEUE"
        ? `${e.kind}|${e.file}|${e.line}|${e.label}`
        : e.kind === "COMMAND"
          ? "COMMAND"
          : `${e.kind}|${e.file}`;
    byKey.set(key, [...(byKey.get(key) ?? []), e]);
  }
  return [...byKey.values()].map((members) => {
    const traced = members.map((m) => ({ m, t: trace(m) }));
    const best = traced.reduce((a, b) => (b.t.length > a.t.length ? b : a));
    return { kind: (members[0] as Facts["entries"][number]).kind, members, lead: best.m, trace: best.t };
  });
}

/**
 * The Inside spec of a project from its facts file: entry points grouped by what they are for, the story of
 * each (steps between parts of the project, followed only through calls the code proves), and the data and
 * outside services those steps touch. Undefined when the facts do not carry the inside part. `items` are the
 * sentences a model may write once; `words` holds those it already wrote.
 */
export function buildInside(
  facts: GraphifyFacts,
  ctx: InsideContext,
  words: Words = NO_WORDS,
): { spec: InsideSpec; items: WordItem[] } | undefined {
  const inside = facts.inside;
  if (inside === undefined || facts.v < 3) return undefined;
  const defs = new Map(inside.defs.map((d) => [d.id, d]));
  const uses = new Map<string, Use[]>();
  for (const u of inside.uses) uses.set(u.fn, [...(uses.get(u.fn) ?? []), u]);
  const g = { defs, calls: provedCalls(inside), uses, project: ctx.project };
  const raw = inside.entries.filter((e) => defs.has(e.fn));
  const unique = [...new Map(raw.map((e) => [entryId(e.kind, e.label, e.file), e])).values()];
  const groups = groupsOf(unique, (e) =>
    traceOf(
      {
        kind: e.kind,
        raw: e.label,
        file: e.file,
        line: e.line,
        fn: e.fn,
        id: entryId(e.kind, e.label, e.file),
      },
      g,
    ),
  );
  // The best of each kind first (the longest story), then the longest stories of any kind.
  const score = (x: Group) =>
    x.trace.length +
    3 * x.trace.filter((t) => t.data !== undefined).length +
    Math.min(x.trace[0]?.step.fns.length ?? 0, 8) / 4 +
    (x.lead.members?.length ? 100 : 0);
  // Worth drawing: it goes somewhere, lists handlers, or its own part does real work.
  const substantive = (x: Group) =>
    x.trace.length > 1 || (x.lead.members?.length ?? 0) > 0 || (x.trace[0]?.step.fns.length ?? 0) > 2;
  const ranked = groups.toSorted(
    (a, b) =>
      score(b) - score(a) ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.lead.file.localeCompare(b.lead.file) ||
      a.lead.line - b.lead.line,
  );
  const shown: Group[] = [];
  for (const kind of Object.keys(KIND_RANK) as InsideTrigger[]) {
    const best = ranked.filter((x) => x.kind === kind && substantive(x)).slice(0, kind === "HTTP" ? 2 : 1);
    for (const b of best) if (shown.length < ENTRIES_SHOWN) shown.push(b);
  }
  for (const x of ranked) {
    if (shown.length >= ENTRIES_SHOWN) break;
    if (!shown.includes(x) && substantive(x)) shown.push(x);
  }
  if (shown.length === 0) shown.push(...ranked.slice(0, ENTRIES_SHOWN));
  const drawn = shown.toSorted(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.lead.file.localeCompare(b.lead.file) ||
      a.lead.line - b.lead.line,
  );
  const rest = groups
    .filter((x) => !shown.includes(x))
    .toSorted(
      (a, b) =>
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        a.lead.file.localeCompare(b.lead.file) ||
        a.lead.line - b.lead.line,
    );

  const items: WordItem[] = [];
  const data = new Map<string, InsideData>();
  const usesOut: InsideSpec["uses"] = [];
  const callsOut = new Map<string, InsideSpec["calls"][number]>();
  const fnKind = new Map<string, InsideTrigger>();
  const fnOrder: string[] = [];
  const noteFn = (id: string, kind: InsideTrigger) => {
    if (!fnKind.has(id)) {
      fnKind.set(id, kind);
      fnOrder.push(id);
    }
  };
  const entries: InsideEntry[] = drawn.map((grp) => {
    const lead = grp.lead;
    const id = entryId(lead.kind, lead.label, lead.file);
    const text = groupLabel(grp);
    const gk = sha(`${ctx.project}|g|${id}|${grp.members.length}`);
    const members = (
      lead.members !== undefined && lead.members.length > 0
        ? lead.members
        : grp.members.map((m) => ({ label: m.label, file: m.file, line: m.line }))
    ).slice(0, 500);
    items.push({
      key: gk,
      kind: "group",
      part: partOf(lead.file),
      role: `purpose of ${grp.kind} entry`,
      file: lead.file,
      line: lead.line,
      end: lead.line,
      members: members.slice(0, 12).map((m) => m.label),
    });
    const steps: InsideStepSpec[] = grp.trace.map((t) => {
      items.push(t.step.item);
      const { template, item: _item, ...rest2 } = t.step;
      return { ...rest2, text: words.get(t.step.wordsKey ?? "") ?? template };
    });
    // A step key names a line on the canvas; the entry's own key uses the group's id.
    const fixed = steps.map((s) => (s.kind === "entry" ? { ...s, key: `i:${id}`, from: text.raw } : s));
    noteFn(lead.fn, grp.kind);
    for (const t of grp.trace) {
      if (t.call !== undefined) {
        noteFn(t.call.to, grp.kind);
        const from = defs.get(t.call.from);
        callsOut.set(t.step.key, {
          from: t.call.from,
          to: t.call.to,
          file: from?.file ?? lead.file,
          line: t.call.line,
        });
      }
      if (t.data !== undefined && t.use !== undefined) {
        // The canvas draws one box per datastore step; the rest of its tables are named in the sentence.
        for (const x of [{ data: t.data, use: t.use }]) {
          data.set(x.data.id, x.data);
          if (!usesOut.some((u) => u.fn === x.use.fn && u.data === x.data.id))
            usesOut.push({
              fn: x.use.fn,
              data: x.data.id,
              file: x.use.file,
              line: x.use.line,
              verb: x.use.verb,
            });
        }
        noteFn(t.use.fn, grp.kind);
      }
    }
    return {
      id,
      kind: grp.kind,
      label: words.get(gk) ?? text.label,
      raw: text.raw,
      file: lead.file,
      line: lead.line,
      fn: lead.fn,
      count: lead.count ?? grp.members.length,
      members,
      wordsKey: gk,
      steps: fixed,
    };
  });

  // Calls over HTTP to another project or an outside service, from the functions the stories reach.
  const shownFns = new Set(fnOrder);
  const byFile = new Map<string, Def[]>();
  for (const d of inside.defs) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);
  for (const call of facts.calls) {
    if (isLoopbackHost(call.host)) continue;
    const inner = (byFile.get(call.file) ?? [])
      .filter((d) => d.line <= call.line && call.line <= d.end)
      .toSorted((a, b) => a.end - a.line - (b.end - b.line))[0];
    if (inner === undefined || !shownFns.has(inner.id)) continue;
    const owner = ctx.owner(call.host, call.port ?? undefined) ?? {
      kind: "out" as const,
      name: outsideOfHost(call.host)?.label ?? call.host,
    };
    const d: InsideData =
      owner.kind === "proj"
        ? { id: `proj:${owner.name}`, kind: "proj", name: owner.name, sub: "project" }
        : {
            id: `out:${owner.name}`,
            kind: "out",
            name: owner.name,
            sub: OUT_SUB[owner.name] ?? "outside service",
          };
    data.set(d.id, d);
    if (!usesOut.some((u) => u.fn === inner.id && u.data === d.id))
      usesOut.push({ fn: inner.id, data: d.id, file: call.file, line: call.line, verb: "call" });
  }

  const ordered = fnOrder.filter((id) => defs.has(id)).slice(0, FNS_MAX);
  const keep = new Set(ordered);
  const serviceOf = (id: string) => serviceFor(fnKind.get(id) as InsideTrigger, ctx.services);
  const serviceOrder = [...new Set(ordered.map(serviceOf))];
  const fns = ordered
    .map((id) => {
      const d = defs.get(id) as Def;
      return { id, file: d.file, line: d.line, doc: d.doc, service: serviceOf(id) };
    })
    .toSorted((x, y) => serviceOrder.indexOf(x.service) - serviceOrder.indexOf(y.service));

  const totals: Record<string, number> = {};
  for (const x of groups) totals[x.kind] = (totals[x.kind] ?? 0) + (x.lead.count ?? x.members.length);
  const more: InsideMoreEntry[] = rest.slice(0, 400).map((x) => {
    const t = groupLabel(x);
    return {
      id: entryId(x.lead.kind, x.lead.label, x.lead.file),
      kind: x.kind,
      label: t.label,
      raw: t.raw,
      file: x.lead.file,
      line: x.lead.line,
      count: x.lead.count ?? x.members.length,
    };
  });
  const dbNames = [
    ...new Set([
      ...[...data.values()].filter((d) => d.kind === "db").map((d) => d.sub.split(" ")[0] as string),
      ...ctx.dbs,
      ...inside.stores.map((s) => s.name),
    ]),
  ].filter((d) => d !== "datastore");
  const spec: InsideSpec = {
    v: 1,
    project: ctx.project,
    entries,
    more,
    totals,
    fns,
    data: [...data.values()].slice(0, 200),
    calls: [...callsOut.values()].filter((c) => keep.has(c.from) && keep.has(c.to)),
    uses: usesOut.filter((u) => keep.has(u.fn)),
    services: serviceOrder,
    dbs: dbNames.slice(0, 20),
    hidden: Math.max(0, fnOrder.length - ordered.length),
  };
  return { spec, items };
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

/** When a project's facts file was last written, without reading it. Undefined when there is none. */
export async function factsStamp(folder: string): Promise<number | undefined> {
  try {
    return (await stat(join(folder, GRAPHIFY_FACTS_FILE))).mtimeMs;
  } catch {
    return undefined;
  }
}
