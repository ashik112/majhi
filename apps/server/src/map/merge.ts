import { edgeId, type MapEdge, type MapEndpoint, type MapNode, type ProjectMap } from "@majhi/shared";
import { deriveLines, mergeEndpoints } from "./endpoints.ts";

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

/** Lines drawn from the addresses of a map, with the owner's checks kept from `before`. */
export function linesFrom(
  map: Pick<ProjectMap, "endpoints" | "resolutions">,
  projects: ReadonlySet<string>,
  before: readonly MapEdge[],
): MapEdge[] {
  const checked = new Set(before.filter((e) => e.state === "confirmed").map((e) => e.id));
  return deriveLines(map.endpoints, map.resolutions, projects).map((e) =>
    e.source === "agent" && checked.has(e.id) ? { ...e, state: "confirmed" as const } : e,
  );
}

export function mergeMap(prev: ProjectMap, passes: Passes): ProjectMap {
  const removed = new Set(prev.removed.map((r) => edgeId(r.from, r.to, r.type)));
  const nodes = new Map<string, MapNode>();
  for (const n of passes.config.nodes) nodes.set(n.id, n);
  const projects = new Set(passes.config.nodes.filter((n) => n.project !== undefined).map((n) => n.id));

  const endpoints = mergeEndpoints({
    config: passes.config.endpoints,
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

/**
 * Records what the owner says an address is (or forgets it, without `to`) and draws the lines again from the
 * stored addresses: the answer shows at once and every later update applies it too.
 */
export function answerAddress(
  map: ProjectMap,
  address: { host: string; port: number | undefined; scope: string | undefined },
  to: ProjectMap["resolutions"][number]["to"] | undefined,
): ProjectMap {
  const same = (r: ProjectMap["resolutions"][number]) =>
    r.host === address.host && r.port === address.port && r.scope === address.scope;
  const resolutions = [
    ...map.resolutions.filter((r) => !same(r)),
    ...(to === undefined
      ? []
      : [
          {
            host: address.host,
            ...(address.port === undefined ? {} : { port: address.port }),
            ...(address.scope === undefined ? {} : { scope: address.scope }),
            to,
          },
        ]),
  ];
  const projects = new Set(map.nodes.filter((n) => n.project !== undefined).map((n) => n.id));
  const removed = new Set(map.removed.map((r) => edgeId(r.from, r.to, r.type)));
  const derived = linesFrom({ endpoints: map.endpoints, resolutions }, projects, map.edges).filter(
    (e) => !removed.has(e.id),
  );
  // Every line of the address kind is drawn again; the files' own lines (library, queue, data) stay.
  const rest = map.edges.filter((e) => e.type !== "http");
  return { ...map, resolutions, edges: [...rest, ...derived] };
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
