import { z } from "zod";
import { IdSchema } from "./accounts.ts";
import {
  DIAGRAM_LIMITS,
  DIAGRAM_VERSION,
  DiagramEdgeSchema,
  DiagramNodeSchema,
  type DiagramSpec,
  DiagramSpecSchema,
  type DiagramTone,
} from "./diagram.ts";

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

export const MapEdgeSourceSchema = z.enum(["config", "history", "agent"]);
export type MapEdgeSource = z.infer<typeof MapEdgeSourceSchema>;

/**
 * How sure a line is, in the three tiers of graphify's edges. `extracted`: a file says it outright (a
 * dependency, a compose service name). `inferred`: found through an answer the owner gave (this host is
 * that project). `ambiguous`: proposed from code and not checked; hidden until the owner reviews it.
 */
export const MAP_CONFIDENCE = ["extracted", "inferred", "ambiguous"] as const;
export const MapConfidenceSchema = z.enum(MAP_CONFIDENCE);
export type MapConfidence = z.infer<typeof MapConfidenceSchema>;

/** What the owner sees for each tier, in plain words. */
export const MAP_CONFIDENCE_LABEL: Record<MapConfidence, string> = {
  extracted: "Found in code",
  inferred: "From your answer",
  ambiguous: "Needs a check",
};

/** The role of a project decides its lane on the map. */
export const MAP_ROLES = ["app", "service", "worker"] as const;
export const MapRoleSchema = z.enum(MAP_ROLES);
export type MapRole = z.infer<typeof MapRoleSchema>;
export const MAP_ROLE_LABEL: Record<MapRole, string> = {
  app: "App",
  service: "Service",
  worker: "Worker",
};

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
  source: z.enum(["config", "agent"]),
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

/** Bumped when what the passes write changes shape; an older stored map reads as never updated. */
export const MAP_RULES = 2;

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

export const EMPTY_MAP: ProjectMap = {
  v: DIAGRAM_VERSION,
  nodes: [],
  edges: [],
  removed: [],
  endpoints: [],
  resolutions: [],
  roles: [],
};

/** A task still open in a project, for the node's panel. */
export const MapTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  projects: z.array(z.string()),
});
export type MapTask = z.infer<typeof MapTaskSchema>;

/** What an update is doing now, for the progress line. */
export const MapRunningSchema = z.object({
  phase: z.enum(["config", "history", "code", "saving"]),
  text: z.string(),
  at: z.string(),
  /** Code pass: projects read so far. */
  done: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
});
export type MapRunning = z.infer<typeof MapRunningSchema>;

/** What the last update did, in numbers. */
export const MapReportSchema = z.object({
  at: z.string(),
  projects: z.number().int().nonnegative(),
  /** Lines added or changed by the code pass, waiting for the owner. */
  fresh: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  /** Why the code pass did not run or stopped early, in plain words. */
  note: z.string().optional(),
});
export type MapReport = z.infer<typeof MapReportSchema>;

export const MapViewSchema = z.object({
  org: z.string(),
  map: ProjectMapSchema,
  /** When the map was last updated. Absent: never. */
  updatedAt: z.string().optional(),
  /** Tasks merged in the workspace since `updatedAt` (all of them when it was never updated). */
  mergesSince: z.number().int().nonnegative(),
  running: MapRunningSchema.optional(),
  /** Why the last update that ran in the background failed. Cleared when the next one starts. */
  failed: z.string().optional(),
  report: MapReportSchema.optional(),
  /** Open tasks by project, so a node can list them. */
  tasks: z.array(MapTaskSchema),
  /** Tasks that changed each project in the last 7 days. */
  changedThisWeek: z.array(z.string()),
  /** Registered projects of the workspace, with their checkout path (for "Open in editor"). */
  projects: z.array(z.object({ id: z.string(), path: z.string(), exists: z.boolean() })),
});
export type MapView = z.infer<typeof MapViewSchema>;

export const MapEstimateSchema = z.object({
  projects: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  /** Dollars, from the price table. Absent when the model has no price. */
  usd: z.number().nonnegative().optional(),
  /** The most one update spends: the code pass stops there. */
  cap: z.number().nonnegative(),
  /** Why there is no code pass, when there is none: no model set, no projects. */
  note: z.string().optional(),
});
export type MapEstimate = z.infer<typeof MapEstimateSchema>;

export const MapOrgInputSchema = z.object({ org: IdSchema });
export const MapAnswerInputSchema = z.object({
  org: IdSchema,
  /** `host` or `host:port`, as in a URL. */
  address: z.string().trim().min(1).max(200),
  /** For a local address: the project that wrote it. */
  scope: z.string().min(1).max(120).optional(),
  /** Absent: forget the answer. */
  to: MapAnswerSchema.optional(),
});
export const MapRoleInputSchema = z.object({
  org: IdSchema,
  project: z.string().min(1).max(120),
  /** Absent: back to the role the dependencies show. */
  role: MapRoleSchema.optional(),
});
export const MapEdgeInputSchema = z.object({ org: IdSchema, id: z.string().min(1).max(300) });

/** What the owner's page says each line type means. */
export const MAP_EDGE_LABEL: Record<MapEdgeType, string> = {
  http: "Calls over HTTP",
  queue: "Through a job queue",
  data: "Reads and writes data",
  lib: "Uses it as a library",
  deploy: "Runs together with",
  together: "Tasks change them together",
};

/** The most a single map update spends on the model, in dollars. */
export const MAP_COST_CAP_USD = 0.5;
/** A pair of projects shows a "changes together" line from this many tasks. */
export const MAP_TOGETHER_MIN = 3;
/** The slice of the map in TASK.md is at most this many lines. */
export const MAP_BRIEF_LINES = 8;

export const ShowMapInputSchema = z.object({
  /** A project id: draw the boxes within `depth` lines of it. Without it, the whole map. */
  around: z.string().trim().min(1).max(120).optional(),
  depth: z.union([z.literal(1), z.literal(2)]).default(1),
});

const NODE_TONE: Record<MapNode["kind"], DiagramTone> = {
  project: "accent",
  library: "neutral",
  database: "good",
  queue: "accent",
  cache: "accent",
  outside: "neutral",
  connection: "neutral",
};

/**
 * A slice of a workspace's stored map as a diagram: the boxes within `depth` lines of `around` (the
 * whole map without it, the best connected 40 when it is bigger). Lines the owner has not checked yet
 * are dashed and marked. Returns a reason when there is nothing to draw.
 */
export function mapSlice(
  map: ProjectMap,
  options: { around?: string | undefined; depth: 1 | 2; title?: string },
): { spec: DiagramSpec } | { problem: string } {
  if (map.nodes.length === 0) {
    return { problem: "This workspace has no map yet. The owner updates it on the Map page." };
  }
  // Weak lines and lines nobody has checked are not part of the picture an agent is shown.
  const lines = map.edges.filter(
    (e) => e.type !== "together" && !(e.state === "new" && e.confidence === "ambiguous"),
  );
  const neighbours = (id: string) =>
    lines.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : []));
  let keep: string[];
  if (options.around === undefined) {
    const degree = (id: string) => neighbours(id).length;
    keep = map.nodes
      .map((n) => n.id)
      .toSorted((a, b) => degree(b) - degree(a) || a.localeCompare(b))
      .slice(0, DIAGRAM_LIMITS.nodes);
  } else {
    const start = map.nodes.find((n) => n.id === options.around || n.project === options.around);
    if (start === undefined)
      return { problem: `There is no project "${options.around}" on this workspace's map.` };
    const seen = new Set([start.id]);
    let frontier = [start.id];
    for (let d = 0; d < options.depth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const other of neighbours(id)) {
          if (!seen.has(other)) {
            seen.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    keep = [...seen].slice(0, DIAGRAM_LIMITS.nodes);
  }
  const kept = new Set(keep);
  const nodes = map.nodes
    .filter((n) => kept.has(n.id))
    .map((n) => ({
      id: n.id,
      label: n.label,
      ...(n.sub === undefined ? {} : { sub: n.sub }),
      kind: n.kind,
      tone: NODE_TONE[n.kind],
    }));
  const edges = lines
    .filter((e: MapEdge) => kept.has(e.from) && kept.has(e.to))
    .slice(0, DIAGRAM_LIMITS.edges)
    .map((e) => ({
      from: e.from,
      to: e.to,
      label:
        e.state === "new"
          ? `${e.label} (new)`.slice(0, DIAGRAM_LIMITS.label)
          : e.label.slice(0, DIAGRAM_LIMITS.label),
      type: e.type,
      ...(e.state === "new" ? { style: "dashed" as const, tone: "warn" as const } : {}),
    }));
  const focus =
    options.around === undefined
      ? undefined
      : nodes.find(
          (n) => n.id === options.around || n.id === map.nodes.find((m) => m.project === options.around)?.id,
        )?.id;
  const spec = DiagramSpecSchema.parse({
    title:
      options.title ??
      (options.around === undefined ? "How the projects connect" : `Around ${options.around}`),
    layout: "top-down",
    nodes,
    edges,
    ...(focus === undefined ? {} : { focus }),
  });
  return { spec };
}
