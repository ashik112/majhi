import { z } from "zod";

/**
 * What graphify leaves in a project's map folder (SPEC 5.21): its own `graph.json`, and `majhi-facts.json`
 * from `docker/map-extract.py`. Both are read from disk, so both are checked here. Unknown fields are
 * dropped; a field graphify adds later never breaks the read.
 */

export const GRAPHIFY_CONFIDENCE = ["EXTRACTED", "INFERRED", "AMBIGUOUS"] as const;

export const GraphifyNodeSchema = z.object({
  id: z.string().min(1).max(400),
  label: z.string().max(400).default(""),
  source_file: z.string().max(600).optional(),
  /** `L154`. */
  source_location: z.string().max(40).optional(),
  community: z.number().int().optional(),
  community_name: z.string().max(200).optional(),
  file_type: z.string().max(40).optional(),
});
export type GraphifyNode = z.infer<typeof GraphifyNodeSchema>;

export const GraphifyLinkSchema = z.object({
  source: z.string().min(1).max(400),
  target: z.string().min(1).max(400),
  relation: z.string().max(60).default("related"),
  confidence: z.enum(GRAPHIFY_CONFIDENCE).optional(),
  source_file: z.string().max(600).optional(),
  source_location: z.string().max(40).optional(),
});
export type GraphifyLink = z.infer<typeof GraphifyLinkSchema>;

export const GraphifyGraphSchema = z.object({
  nodes: z.array(GraphifyNodeSchema).max(200_000),
  links: z.array(GraphifyLinkSchema).max(1_000_000),
});
export type GraphifyGraph = z.infer<typeof GraphifyGraphSchema>;

/**
 * An HTTP client call whose first argument is an address the file writes: `literal` (the address is in the
 * file) or `env-default` (an environment read whose default is the address). Only scheme, host and port are
 * kept: a password, path or query never leaves the container.
 */
export const GraphifyCallSchema = z.object({
  file: z.string().min(1).max(600),
  line: z.number().int().positive(),
  client: z.string().max(80),
  how: z.enum(["literal", "env-default"]),
  key: z.string().max(120).nullable(),
  scheme: z.string().max(10),
  host: z.string().min(1).max(200),
  port: z.number().int().positive().max(65535).nullable(),
});
export type GraphifyCall = z.infer<typeof GraphifyCallSchema>;

/**
 * What `docker/map_inside.py` found in one project's code: its functions, the calls between them, what
 * starts work (routes, schedules, queue consumers, commands) and what uses a datastore or an outside service.
 */
export const GraphifyInsideSchema = z.object({
  defs: z
    .array(
      z.object({
        id: z.string().min(1).max(160),
        file: z.string().min(1).max(400),
        line: z.number().int().positive(),
        end: z.number().int().positive(),
        doc: z.string().max(200).default(""),
      }),
    )
    .max(60000),
  calls: z
    .array(
      z.object({
        from: z.string().max(160),
        to: z.string().max(160),
        line: z.number().int().positive(),
        /**
         * How the call was proved: `same-file` (defined in the same file) or `import` (the file imports it).
         * `name` is a match by name alone; it is never followed.
         */
        how: z.enum(["same-file", "import", "name"]).default("name"),
        /** True when every such call sits in code that only runs when something went wrong. */
        fail: z.boolean().optional(),
      }),
    )
    .max(60000),
  uses: z
    .array(
      z.object({
        fn: z.string().max(160),
        name: z.string().max(80),
        kind: z.enum(["db", "out"]),
        line: z.number().int().positive(),
        verb: z.enum(["read", "write", "call", "use"]),
        target: z.string().max(120).optional(),
        fail: z.boolean().optional(),
      }),
    )
    .max(60000),
  entries: z
    .array(
      z.object({
        kind: z.enum(["HTTP", "SOCKET", "TOOL", "SCHEDULE", "QUEUE", "COMMAND"]),
        label: z.string().min(1).max(160),
        file: z.string().min(1).max(400),
        line: z.number().int().positive(),
        fn: z.string().min(1).max(160),
        /** A route that dispatches to a table of handlers: the table's keys. */
        members: z
          .array(
            z.object({
              label: z.string().min(1).max(160),
              file: z.string().min(1).max(400),
              line: z.number().int().positive(),
              /** The function that handles it, when the code ties it to one. */
              fn: z.string().max(160).optional(),
            }),
          )
          .max(600)
          .optional(),
        count: z.number().int().nonnegative().optional(),
      }),
    )
    .max(2000),
  /** Datastores from the project's dependencies and imports, with the tables its code or schema names. */
  stores: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        kind: z.literal("db"),
        via: z.array(z.string().max(80)).max(6).default([]),
        tables: z.array(z.string().max(80)).max(60).optional(),
      }),
    )
    .max(20)
    .default([]),
  /** Datastores the dependencies name that no code uses and no schema backs. */
  declared: z.array(z.string().max(60)).max(20).default([]),
});
export type GraphifyInside = z.infer<typeof GraphifyInsideSchema>;

export const GraphifyFactsSchema = z.object({
  /** 2 adds `inside`, 3 proves calls by file and import; an older read shows as "not read inside yet". */
  v: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  files: z.number().int().nonnegative(),
  calls: z.array(GraphifyCallSchema).max(2000),
  inside: GraphifyInsideSchema.optional(),
});
export type GraphifyFacts = z.infer<typeof GraphifyFactsSchema>;

/** Files in a project's map folder. */
export const GRAPHIFY_GRAPH_FILE = "graph.json";
export const GRAPHIFY_FACTS_FILE = "majhi-facts.json";
