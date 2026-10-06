import { z } from "zod";
import { IdSchema } from "./accounts.ts";

/**
 * What is inside one project (SPEC 5.21, the Inside tab): where work starts (entry points), the functions
 * it runs, and the datastores and outside services they use. Built on the server from the project's code
 * graph and facts, with no model; every fact carries the file and line it was read at.
 */

export const INSIDE_TRIGGERS = ["HTTP", "SCHEDULE", "QUEUE", "COMMAND"] as const;
export const InsideTriggerSchema = z.enum(INSIDE_TRIGGERS);
export type InsideTrigger = z.infer<typeof InsideTriggerSchema>;

const Name = z.string().min(1).max(160);
const File = z.string().min(1).max(400);
const Line = z.number().int().positive();

export const InsideEntrySchema = z.object({
  /** Stable for the same kind, label and file, so a journey can point at it. */
  id: z.string().min(1).max(40),
  kind: InsideTriggerSchema,
  label: Name,
  file: File,
  line: Line,
  /** The function it runs. */
  fn: Name,
});
export type InsideEntry = z.infer<typeof InsideEntrySchema>;

export const InsideFnSchema = z.object({
  id: Name,
  file: File,
  line: Line,
  /** The first line of its docstring or comment. */
  doc: z.string().max(120).default(""),
  /** The compose service that runs it, or the kind of entry that starts it. */
  service: z.string().min(1).max(80),
});
export type InsideFn = z.infer<typeof InsideFnSchema>;

export const InsideDataSchema = z.object({
  id: Name,
  /** `db`: a datastore (or one of its tables), `out`: an outside service, `proj`: another project of the workspace. */
  kind: z.enum(["db", "out", "proj"]),
  name: Name,
  sub: z.string().max(80).default(""),
});
export type InsideData = z.infer<typeof InsideDataSchema>;

export const InsideCallSchema = z.object({ from: Name, to: Name, file: File, line: Line });
export type InsideCall = z.infer<typeof InsideCallSchema>;

export const InsideUseSchema = z.object({
  fn: Name,
  data: Name,
  file: File,
  line: Line,
  verb: z.enum(["read", "write", "call", "use"]),
});
export type InsideUse = z.infer<typeof InsideUseSchema>;

export const InsideSpecSchema = z.object({
  v: z.literal(1).default(1),
  project: IdSchema,
  entries: z.array(InsideEntrySchema).max(200),
  fns: z.array(InsideFnSchema).max(300),
  data: z.array(InsideDataSchema).max(200),
  calls: z.array(InsideCallSchema).max(1000),
  uses: z.array(InsideUseSchema).max(1000),
  /** The services that run the functions, in the order the frames are drawn. */
  services: z.array(z.string().min(1).max(80)).max(40),
  /** Datastores the project uses, from its config (a Postgres chip), even when no function was seen using one. */
  dbs: z.array(z.string().min(1).max(60)).max(20),
  /** Functions left out because the project has more than the page shows. */
  hidden: z.number().int().nonnegative().default(0),
});
export type InsideSpec = z.infer<typeof InsideSpecSchema>;

/** `unread`: majhi has not read the code of this project yet. `ready` with an empty spec: it read it and found nothing it knows. */
export const InsideViewSchema = z.object({
  project: IdSchema,
  state: z.enum(["ready", "unread"]),
  spec: InsideSpecSchema.optional(),
});
export type InsideView = z.infer<typeof InsideViewSchema>;

export const InsideInputSchema = z.object({ org: IdSchema, project: z.string().min(1).max(120) });

// ---------------------------------------------------------------------------
// The story of one entry point, in plain words

/** What a step is drawn on: the entry's own line, a call between two functions, or a function using data. */
export interface InsideStep {
  /** `i:<entry id>`, `c:<from>><to>` or `d:<fn>><data id>`: the line this step lights on the canvas. */
  key: string;
  text: string;
  /** `app/api.py:42`. */
  where: string;
  file: string;
  line: number;
  from: string;
  to: string;
  kind: "entry" | "call" | "data";
}

/** Known services: what a function does with them, in a few plain words after the function's name. */
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

const ENTRY_TEXT: Record<InsideTrigger, (label: string, fn: string) => string> = {
  HTTP: (label, fn) => `A request to ${label} calls ${fn}.`,
  SCHEDULE: (label, fn) => `On schedule (${label}) the scheduler starts ${fn}.`,
  QUEUE: (label, fn) => `A job for ${label} starts ${fn}.`,
  COMMAND: (label, fn) => `The command ${label} runs ${fn}.`,
};

/** The text of a function using data. Deterministic: the verb and the kind of data decide it, nothing else. */
export function dataText(fn: string, data: InsideData, verb: InsideUse["verb"]): string {
  if (data.kind === "out") {
    const phrase = PHRASE[data.name];
    return phrase === undefined ? `${fn} sends a request to ${data.name}.` : `${fn} ${phrase}.`;
  }
  if (data.kind === "proj") return `${fn} hands the work to ${data.name}.`;
  const store = data.sub.endsWith("table") ? `the ${data.name} table` : data.name;
  if (verb === "write") return `${fn} saves to ${store}.`;
  if (verb === "read") return `${fn} reads from ${store}.`;
  return `${fn} uses ${store}.`;
}

/** How deep a story follows calls from the entry's function. */
export const FLOW_DEPTH = 6;

/**
 * The story of an entry point: the entry itself, then, in the order the code reads, each call to another
 * function and each use of data, following calls depth first. A function is told once.
 */
export function flowOf(spec: InsideSpec, entry: InsideEntry): InsideStep[] {
  const fnById = new Map(spec.fns.map((f) => [f.id, f]));
  const dataById = new Map(spec.data.map((d) => [d.id, d]));
  const steps: InsideStep[] = [
    {
      key: `i:${entry.id}`,
      text: ENTRY_TEXT[entry.kind](entry.label, entry.fn),
      where: `${entry.file}:${entry.line}`,
      file: entry.file,
      line: entry.line,
      from: entry.label,
      to: entry.fn,
      kind: "entry",
    },
  ];
  const seen = new Set<string>();
  const walk = (fn: string, depth: number) => {
    if (seen.has(fn) || depth > FLOW_DEPTH) return;
    seen.add(fn);
    const here = [
      ...spec.calls.filter((c) => c.from === fn).map((c) => ({ line: c.line, call: c })),
      ...spec.uses.filter((u) => u.fn === fn).map((u) => ({ line: u.line, use: u })),
    ].toSorted((a, b) => a.line - b.line);
    for (const item of here) {
      if ("call" in item) {
        const c = item.call;
        if (!fnById.has(c.to)) continue;
        steps.push({
          key: `c:${c.from}>${c.to}`,
          text: `${c.from} asks ${c.to}.`,
          where: `${c.file}:${c.line}`,
          file: c.file,
          line: c.line,
          from: c.from,
          to: c.to,
          kind: "call",
        });
        walk(c.to, depth + 1);
      } else {
        const u = item.use;
        const d = dataById.get(u.data);
        if (d === undefined) continue;
        steps.push({
          key: `d:${u.fn}>${u.data}`,
          text: dataText(u.fn, d, u.verb),
          where: `${u.file}:${u.line}`,
          file: u.file,
          line: u.line,
          from: u.fn,
          to: d.name,
          kind: "data",
        });
      }
    }
  };
  walk(entry.fn, 0);
  return steps;
}
