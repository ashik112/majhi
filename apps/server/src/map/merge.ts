import { edgeId, type MapEdge, type MapEndpoint, type MapNode, type ProjectMap } from "@majhi/shared";
import { linesFrom } from "../wiki/system/answers.ts";
import { mergeEndpoints } from "../wiki/system/endpoints.ts";

/**
 * Puts the passes of one update together with the stored map. Pure.
 *
 * - Lines from the config and history passes are made again every update, so a dependency that is gone
 *   leaves the map. They are `confirmed`: the files say so.
 * - Calls between projects are not found directly: the passes find addresses, and a line exists only when an
 *   address has a known owner (a compose service, or the owner's answer). What the model found stays until
 *   it reads that project again, and the owner's check of such a line carries over.
 * - A line the owner removed is never added again by any pass.
 * - The owner's answers and role choices carry over as they are.
 */

export interface Passes {
  /** The config pass: every project box, the lines the files show, and the addresses they call. */
  config: {
    nodes: readonly MapNode[];
    edges: readonly MapEdge[];
    endpoints: readonly MapEndpoint[];
    services: ReadonlyMap<string, string>;
  };
  /** Pairs of projects that tasks changed together, already cut to the strong ones. */
  together: readonly { a: string; b: string; tasks: number }[];
  /** The code pass: addresses the model found in code, with proof, and the projects it read. */
  found: { endpoints: readonly MapEndpoint[]; reread: ReadonlySet<string> };
  /**
   * The graph pass: addresses HTTP client calls use in code (graphify's reader), and the projects whose
   * graph was read this time. A project not read keeps what an earlier update found.
   */
  graph?: { endpoints: readonly MapEndpoint[]; read: ReadonlySet<string> } | undefined;
}

export function togetherEdge(pair: { a: string; b: string; tasks: number }): MapEdge {
  return {
    id: edgeId(pair.a, pair.b, "together"),
    from: pair.a,
    to: pair.b,
    type: "together",
    label: `changes together · ${pair.tasks} tasks`,
    evidence: [],
    source: "history",
    state: "confirmed",
    confidence: "extracted",
    tasks: pair.tasks,
  };
}

export function mergeMap(prev: ProjectMap, passes: Passes): ProjectMap {
  const removed = new Set(prev.removed.map((r) => edgeId(r.from, r.to, r.type)));
  const nodes = new Map<string, MapNode>();
  for (const n of passes.config.nodes) nodes.set(n.id, n);
  const projects = new Set(passes.config.nodes.filter((n) => n.project !== undefined).map((n) => n.id));

  const endpoints = mergeEndpoints({
    config: [...passes.config.endpoints, ...(passes.graph?.endpoints ?? [])],
    graphRead: passes.graph?.read ?? new Set<string>(),
    previous: prev.endpoints,
    found: passes.found.endpoints,
    reread: passes.found.reread,
    projects,
    services: passes.config.services,
  });
  const resolutions = prev.resolutions;

  const edges = new Map<string, MapEdge>();
  for (const e of passes.config.edges) edges.set(e.id, e);
  for (const pair of passes.together) {
    const e = togetherEdge(pair);
    if (nodes.has(e.from) && nodes.has(e.to)) edges.set(e.id, e);
  }
  for (const e of linesFrom({ endpoints, resolutions }, projects, prev.edges)) edges.set(e.id, e);

  const kept = [...edges.values()].filter((e) => !removed.has(e.id) && nodes.has(e.from) && nodes.has(e.to));
  return {
    v: prev.v,
    nodes: [...nodes.values()],
    edges: kept,
    removed: prev.removed,
    endpoints,
    resolutions,
    roles: prev.roles.filter((r) => projects.has(r.project)),
  };
}

/** Marks a new line as checked by the owner. */
export function confirmEdge(map: ProjectMap, id: string): ProjectMap {
  return { ...map, edges: map.edges.map((e) => (e.id === id ? { ...e, state: "confirmed" as const } : e)) };
}

/** Removes a line and remembers it, so no pass adds it again. A box left with no line stays: it may be a project. */
export function removeEdge(map: ProjectMap, id: string): ProjectMap {
  const gone = map.edges.find((e) => e.id === id);
  if (gone === undefined) return map;
  const removed = map.removed.some((r) => edgeId(r.from, r.to, r.type) === id)
    ? map.removed
    : [...map.removed, { from: gone.from, to: gone.to, type: gone.type }];
  return { ...map, edges: map.edges.filter((e) => e.id !== id), removed };
}

/** Sets or clears the owner's choice of a project's role. */
export function setRole(
  map: ProjectMap,
  project: string,
  role: ProjectMap["roles"][number]["role"] | undefined,
) {
  const roles = [
    ...map.roles.filter((r) => r.project !== project),
    ...(role === undefined ? [] : [{ project, role }]),
  ];
  return { ...map, roles };
}
