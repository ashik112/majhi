import { z } from "zod";
import { IdSchema } from "./accounts.ts";
import { DIAGRAM_VERSION, DiagramEdgeSchema, DiagramNodeSchema } from "./diagram.ts";

/**
 * The project map (SPEC 5.21): one stored graph per workspace of how its projects connect. A config pass
 * and a history pass fill it from files and majhi's own records with no model; a code pass reads a
 * bounded set of files with the cheapest model and proposes lines that land as `new` for the owner to check.
 */

export const MAP_NODE_KINDS = [
  "project",
  "library",
  "database",
  "queue",
  "cache",
  "outside",
  "connection",
] as const;
export const MapNodeKindSchema = z.enum(MAP_NODE_KINDS);
export type MapNodeKind = z.infer<typeof MapNodeKindSchema>;

/** `together` is the weak line from history: two projects that tasks changed together, shown only when strong. */
export const MAP_EDGE_TYPES = ["http", "queue", "data", "lib", "deploy", "together"] as const;
export const MapEdgeTypeSchema = z.enum(MAP_EDGE_TYPES);
export type MapEdgeType = z.infer<typeof MapEdgeTypeSchema>;

export const MapEdgeSourceSchema = z.enum(["config", "history", "agent", "graph"]);
export type MapEdgeSource = z.infer<typeof MapEdgeSourceSchema>;

/**
 * How sure a line is, in the three tiers of graphify's edges. `extracted`: a file says it outright (a
 * dependency, a compose service name). `inferred`: found through an answer the owner gave (this host is
 * that project). `ambiguous`: proposed from code and not checked; hidden until the owner reviews it.
 */
export const MAP_CONFIDENCE = ["extracted", "inferred", "ambiguous"] as const;
export const MapConfidenceSchema = z.enum(MAP_CONFIDENCE);
export type MapConfidence = z.infer<typeof MapConfidenceSchema>;

/** The role of a project decides its lane on the map. */
export const MAP_ROLES = ["app", "service", "queue", "worker"] as const;
export const MapRoleSchema = z.enum(MAP_ROLES);
export type MapRole = z.infer<typeof MapRoleSchema>;

/** `new`: found by the code pass and not yet checked by the owner. */
export const MapEdgeStateSchema = z.enum(["confirmed", "new"]);
export type MapEdgeState = z.infer<typeof MapEdgeStateSchema>;

/** The line a map line is based on. `file` is relative to the project's checkout. */
export const MapEvidenceSchema = z.object({
  project: z.string().min(1).max(120),
  file: z.string().min(1).max(400),
  line: z.number().int().positive(),
  excerpt: z.string().max(240),
});
export type MapEvidence = z.infer<typeof MapEvidenceSchema>;

/** A box of the map is a diagram box that says what kind of thing it is and which project it is. */
export const MapNodeSchema = DiagramNodeSchema.extend({
  /** A project's own id for projects and libraries, else `<kind>:<slug>`. */
  kind: MapNodeKindSchema,
  label: z.string().min(1).max(80),
  sub: z.string().max(120).optional(),
  /** Where it runs: Vercel, Kubernetes, Docker, an npm package, outside. */
  deploy: z.string().max(60).optional(),
  /** The registered project, when the node is one. */
  project: IdSchema.optional(),
  /** What the project is, from its dependencies. The owner can change it (`ProjectMap.roles`). */
  role: MapRoleSchema.optional(),
  /** What the project is built with, shown on its card: Django, Postgres, Redis. Not nodes. */
  stack: z.array(z.string().min(1).max(30)).max(8).optional(),
  /** Outside services it uses, shown on its card: OpenAI, Stripe. Not nodes. */
  uses: z.array(z.string().min(1).max(40)).max(12).optional(),
});
export type MapNode = z.infer<typeof MapNodeSchema>;

/** A line of the map is a diagram line with its proof, where it came from and whether the owner checked it. */
export const MapEdgeSchema = DiagramEdgeSchema.extend({
  /** `<from>><to>:<type>`. The same line found twice is one line with more evidence. */
  id: z.string().min(1).max(300),
  type: MapEdgeTypeSchema,
  label: z.string().min(1).max(80),
  evidence: z.array(MapEvidenceSchema).max(12),
  source: MapEdgeSourceSchema,
  state: MapEdgeStateSchema,
  confidence: MapConfidenceSchema.default("extracted"),
  /** For `together`: how many tasks changed both. */
  tasks: z.number().int().positive().optional(),
});
export type MapEdge = z.infer<typeof MapEdgeSchema>;

/** A line the owner removed: no pass adds it again. */
export const MapRemovedSchema = z.object({
  from: z.string().min(1).max(120),
  to: z.string().min(1).max(120),
  type: MapEdgeTypeSchema,
});
export type MapRemoved = z.infer<typeof MapRemovedSchema>;

/** Hosts that mean "this computer": the same name is a different thing in every project that writes it. */
const LOOPBACK: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "host.docker.internal",
]);
export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host.toLowerCase());

/**
 * An address a project's files call: a host and port, found in a URL. A local address is only the same
 * thing inside one project, so it carries that project in `scope`.
 */
export function endpointId(host: string, port: number | undefined, scope: string | undefined): string {
  const address = `${host.toLowerCase()}${port === undefined ? "" : `:${port}`}`;
  return scope === undefined ? address : `${scope}@${address}`;
}

/** One place a file calls an address: which project, which variable, and the line as proof. */
export const MapEndpointRefSchema = MapEvidenceSchema.extend({
  /** The variable or code the address was written in. */
  key: z.string().max(120),
  /** `graph`: an HTTP client call graphify's reader found in code (an address written in the file). */
  source: z.enum(["config", "agent", "graph"]),
  /** For `graph`: `extracted` when the address is in the file, `inferred` when it is the default of an environment read. */
  confidence: MapConfidenceSchema.optional(),
});
export type MapEndpointRef = z.infer<typeof MapEndpointRefSchema>;

export const MapEndpointSchema = z.object({
  id: z.string().min(1).max(200),
  host: z.string().min(1).max(200),
  port: z.number().int().positive().max(65535).optional(),
  /** A local address belongs to the project that wrote it. */
  scope: z.string().min(1).max(120).optional(),
  /** The project a compose file proves owns this host name (a service its build makes). */
  known: z.string().min(1).max(120).optional(),
  refs: z.array(MapEndpointRefSchema).max(12),
});
export type MapEndpoint = z.infer<typeof MapEndpointSchema>;

/** What the owner says an address is. */
export const MapAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), project: z.string().min(1).max(120) }),
  z.object({ kind: z.literal("outside") }),
  z.object({ kind: z.literal("ignore") }),
]);
export type MapAnswer = z.infer<typeof MapAnswerSchema>;

/** One answer of the owner, kept for the workspace: every later update applies it. */
export const MapResolutionSchema = z.object({
  host: z.string().min(1).max(200),
  port: z.number().int().positive().max(65535).optional(),
  scope: z.string().min(1).max(120).optional(),
  to: MapAnswerSchema,
});
export type MapResolution = z.infer<typeof MapResolutionSchema>;

export const MapRoleSettingSchema = z.object({ project: z.string().min(1).max(120), role: MapRoleSchema });

export function edgeId(from: string, to: string, type: MapEdgeType): string {
  return `${from}>${to}:${type}`;
}

/** The stored map of one workspace. */
export const ProjectMapSchema = z.object({
  /** The diagram version this map is stored in. */
  v: z.literal(DIAGRAM_VERSION).default(DIAGRAM_VERSION),
  nodes: z.array(MapNodeSchema).max(300),
  edges: z.array(MapEdgeSchema).max(1000),
  removed: z.array(MapRemovedSchema).max(1000),
  /** Every address the files call that is not a known service: unanswered ones are asked about on the page. */
  endpoints: z.array(MapEndpointSchema).max(600).default([]),
  /** The owner's answers: which project, or an outside service, each address is. */
  resolutions: z.array(MapResolutionSchema).max(600).default([]),
  /** The owner's choice of role for a project, over the one the dependencies show. */
  roles: z.array(MapRoleSettingSchema).max(300).default([]),
});
export type ProjectMap = z.infer<typeof ProjectMapSchema>;
