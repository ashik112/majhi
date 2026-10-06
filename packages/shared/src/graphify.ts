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

export const GraphifyFactsSchema = z.object({
  v: z.literal(1),
  files: z.number().int().nonnegative(),
  calls: z.array(GraphifyCallSchema).max(2000),
});
export type GraphifyFacts = z.infer<typeof GraphifyFactsSchema>;

/** Files in a project's map folder. */
export const GRAPHIFY_GRAPH_FILE = "graph.json";
export const GRAPHIFY_FACTS_FILE = "majhi-facts.json";
