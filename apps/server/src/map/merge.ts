import { edgeId, type MapEdge, type MapEvidence, type MapNode, type ProjectMap } from "@majhi/shared";

/**
 * Puts the passes of one update together with the stored map. Pure.
 *
 * - Lines from the config and history passes are made again every update, so a dependency that is gone
 *   leaves the map. They are `confirmed`: the files say so.
 * - Lines the code pass proposed land as `new`. They stay until the owner removes them (a rerun that
 *   does not find one again does not drop it) and a rerun never turns a `confirmed` one back into `new`.
 * - A line the owner removed is never added again by any pass.
 * - A box with no line is kept only when it is a project of the workspace.
 */

export interface Passes {
  /** The config pass: every project box, and the lines the files show. */
  config: { nodes: readonly MapNode[]; edges: readonly MapEdge[] };
  /** Pairs of projects that tasks changed together, already cut to the strong ones. */
  together: readonly { a: string; b: string; tasks: number }[];
  /** The code pass: lines and boxes proposed, with proof. */
  proposed: { nodes: readonly MapNode[]; edges: readonly MapEdge[] };
}

const EVIDENCE_MAX = 12;

function unionEvidence(a: readonly MapEvidence[], b: readonly MapEvidence[]): MapEvidence[] {
  const out = [...a];
  for (const p of b) {
    if (out.length >= EVIDENCE_MAX) break;
    if (!out.some((q) => q.project === p.project && q.file === p.file && q.line === p.line)) out.push(p);
  }
  return out;
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
    tasks: pair.tasks,
  };
}

export function mergeMap(prev: ProjectMap, passes: Passes): ProjectMap {
  const removed = new Set(prev.removed.map((r) => edgeId(r.from, r.to, r.type)));
  const nodes = new Map<string, MapNode>();
  for (const n of passes.config.nodes) nodes.set(n.id, n);
  for (const n of passes.proposed.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);

  const edges = new Map<string, MapEdge>();
  for (const e of passes.config.edges) if (!removed.has(e.id)) edges.set(e.id, e);
  for (const pair of passes.together) {
    const e = togetherEdge(pair);
    if (!removed.has(e.id) && nodes.has(e.from) && nodes.has(e.to)) edges.set(e.id, e);
  }

  // What the code pass found before, and now. The owner's check carries over.
  const before = new Map(prev.edges.filter((e) => e.source === "agent").map((e) => [e.id, e]));
  const proposed = new Map(passes.proposed.edges.map((e) => [e.id, e]));
  for (const id of new Set([...before.keys(), ...proposed.keys()])) {
    if (removed.has(id)) continue;
    const old = before.get(id);
    const fresh = proposed.get(id);
    const base = old ?? fresh;
    if (base === undefined) continue;
    const known = edges.get(id);
    if (known !== undefined) {
      // The files also show it: the proof adds up and the line stays confirmed.
      edges.set(id, { ...known, evidence: unionEvidence(known.evidence, base.evidence) });
      continue;
    }
    edges.set(id, {
      ...base,
      evidence: unionEvidence(old?.evidence ?? [], fresh?.evidence ?? []),
      state: old?.state ?? "new",
    });
  }

  // Boxes the kept lines name, from the passes or from the old map.
  const oldNodes = new Map(prev.nodes.map((n) => [n.id, n]));
  const kept: MapEdge[] = [];
  for (const e of edges.values()) {
    for (const end of [e.from, e.to]) {
      if (!nodes.has(end)) {
        const old = oldNodes.get(end);
        if (old !== undefined) nodes.set(end, old);
      }
    }
    if (nodes.has(e.from) && nodes.has(e.to)) kept.push(e);
  }
  return { v: prev.v, nodes: [...nodes.values()], edges: kept, removed: prev.removed };
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
