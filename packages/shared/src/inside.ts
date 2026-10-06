import { z } from "zod";
import { IdSchema } from "./accounts.ts";

/**
 * What is inside one project (SPEC 5.21, the Inside tab): where work starts (entry points), the functions
 * it runs, and the datastores and outside services they use. Built on the server from the project's code
 * graph and facts, with no model; every fact carries the file and line it was read at.
 */

export const INSIDE_TRIGGERS = ["HTTP", "SOCKET", "TOOL", "SCHEDULE", "QUEUE", "COMMAND"] as const;
export const InsideTriggerSchema = z.enum(INSIDE_TRIGGERS);
export type InsideTrigger = z.infer<typeof InsideTriggerSchema>;

const Name = z.string().min(1).max(160);
const File = z.string().min(1).max(400);
const Line = z.number().int().positive();

/** One step of what happens after an entry point: a part of the project taking over, or a part using data. */
export const InsideStepSpecSchema = z.object({
  /** `i:<entry id>`, `c:<from>><to>` or `d:<fn>><data id>`: the line this step lights on the canvas. */
  key: z.string().min(1).max(400),
  kind: z.enum(["entry", "call", "data"]),
  /** One plain sentence. */
  text: z.string().min(1).max(300),
  /** The part of the project this step happens in ("Connections"), or "Database" for data. */
  part: z.string().min(1).max(60),
  from: Name,
  to: Name,
  file: File,
  line: Line,
  /** The functions of this part that did the work: shown only when the step is opened. */
  fns: z.array(z.object({ id: Name, file: File, line: Line })).max(8),
  /** Names the sentence by what it is about, so a model-written sentence can replace the template one. */
  wordsKey: z.string().max(40).optional(),
});
export type InsideStepSpec = z.infer<typeof InsideStepSpecSchema>;

export const InsideEntrySchema = z.object({
  /** Stable for the same kind, label and file, so a journey can point at it. */
  id: z.string().min(1).max(40),
  kind: InsideTriggerSchema,
  /** What it is for ("Agents call majhi"), or the route itself when no purpose is known. */
  label: Name,
  /** The route or timer as written in code, shown small. */
  raw: z.string().max(200).default(""),
  file: File,
  line: Line,
  /** The function it runs. */
  fn: Name,
  /** The routes, commands or tools grouped under this entry. */
  count: z.number().int().positive().default(1),
  members: z
    .array(z.object({ label: Name, file: File, line: Line }))
    .max(500)
    .default([]),
  /** Key of the sentence that names the group's purpose. */
  wordsKey: z.string().max(40).optional(),
  /** What happens, step by step, followed only through calls proved in code. */
  steps: z.array(InsideStepSpecSchema).max(12).default([]),
  /** What else happens when it goes wrong, one plain line each. Kept out of the numbered steps. */
  ifFails: z.array(z.string().max(200)).max(6).default([]),
});
export type InsideEntry = z.infer<typeof InsideEntrySchema>;

/** An entry point the canvas does not draw: listed under "Show more". */
export const InsideMoreEntrySchema = z.object({
  id: z.string().min(1).max(40),
  kind: InsideTriggerSchema,
  label: Name,
  raw: z.string().max(200).default(""),
  file: File,
  line: Line,
  count: z.number().int().positive().default(1),
});
export type InsideMoreEntry = z.infer<typeof InsideMoreEntrySchema>;

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
  entries: z.array(InsideEntrySchema).max(40),
  /** Entry points beyond those drawn: listed under "Show more". */
  more: z.array(InsideMoreEntrySchema).max(400).default([]),
  /** How many entry points there are of each kind, drawn or not. */
  totals: z.record(z.string(), z.number().int().nonnegative()).default({}),
  fns: z.array(InsideFnSchema).max(300),
  data: z.array(InsideDataSchema).max(200),
  calls: z.array(InsideCallSchema).max(1000),
  uses: z.array(InsideUseSchema).max(1000),
  /** The services that run the functions, in the order the frames are drawn. */
  services: z.array(z.string().min(1).max(80)).max(40),
  /** Datastores the project uses, from its config (a Postgres chip), even when no function was seen using one. */
  dbs: z.array(z.string().min(1).max(60)).max(20),
  /** Datastores named in dependencies or config that no code reached from an entry point uses. */
  declared: z.array(z.string().min(1).max(60)).max(20).default([]),
  /** Functions left out because the project has more than the page shows. */
  hidden: z.number().int().nonnegative().default(0),
});
export type InsideSpec = z.infer<typeof InsideSpecSchema>;

/** The story of one command of a dispatcher route. `followed` is false when its handler cannot be tied to code. */
export const InsideMemberSchema = z.object({
  label: Name,
  file: File,
  line: Line,
  followed: z.boolean(),
  steps: z.array(InsideStepSpecSchema).max(12),
  ifFails: z.array(z.string().max(200)).max(6).default([]),
});
export type InsideMember = z.infer<typeof InsideMemberSchema>;

export const InsideMemberInputSchema = z.object({
  org: IdSchema,
  project: z.string().min(1).max(120),
  entry: z.string().min(1).max(40),
  member: Name,
});

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

/** What a step is drawn on: the entry's own line, a call between two parts, or a function using data. */
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
  part: string;
  fns: { id: string; file: string; line: number }[];
}

/** Steps shown before "Show more". */
export const STEPS_SHOWN = 6;

/** The story of an entry point: what the server worked out, with each step's `where`. */
export function flowOf(_spec: InsideSpec, entry: Pick<InsideEntry, "steps">): InsideStep[] {
  return stepsOf(entry.steps);
}

/** The steps of a story as the page lists them. */
export function stepsOf(steps: readonly InsideStepSpec[]): InsideStep[] {
  return steps.map((s) => ({
    key: s.key,
    text: s.text,
    where: `${s.file}:${s.line}`,
    file: s.file,
    line: s.line,
    from: s.from,
    to: s.to,
    kind: s.kind,
    part: s.part,
    fns: s.fns,
  }));
}
