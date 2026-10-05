import { Graph, layout } from "@dagrejs/dagre";
import type { Diagram } from "@majhi/shared";
import { BOX_H, BOX_W, type Box, type Positioned } from "../types";
import { routeEdges } from "./route";

export interface LayeredOptions {
  rankdir: "TB" | "LR";
  nodesep: number;
  ranksep: number;
  ranker?: "network-simplex" | "tight-tree" | "longest-path";
}

/** The ids of the nodes that hold others: the ones some node names as its `group`. */
export function containersOf(diagram: Diagram): Set<string> {
  return new Set(diagram.nodes.flatMap((n) => (n.group === undefined ? [] : [n.group])));
}

/**
 * Layers by dagre, with groups as frames around their members. Lines that touch a group are drawn but do
 * not place anything (dagre cannot rank across a frame). Flow, top-down, tree and state all use this
 * with different directions and spacing.
 */
export function layered(diagram: Diagram, options: LayeredOptions): Positioned {
  const containers = containersOf(diagram);
  const g = new Graph({ compound: containers.size > 0 });
  g.setGraph({
    rankdir: options.rankdir,
    nodesep: options.nodesep,
    ranksep: options.ranksep,
    marginx: 24,
    marginy: 24,
    ...(options.ranker === undefined ? {} : { ranker: options.ranker }),
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of diagram.nodes) {
    if (containers.has(n.id)) g.setNode(n.id, {});
    else g.setNode(n.id, { width: BOX_W, height: BOX_H });
  }
  if (containers.size > 0)
    for (const n of diagram.nodes) if (n.group !== undefined) g.setParent(n.id, n.group);
  for (const e of diagram.edges) {
    if (e.from === e.to || containers.has(e.from) || containers.has(e.to)) continue;
    if (e.type === "together") continue;
    g.setEdge(e.from, e.to);
  }
  layout(g);
  const nodes = new Map<string, Box>();
  const groups = new Map<string, Box>();
  for (const n of diagram.nodes) {
    const p = g.node(n.id);
    if (containers.has(n.id)) {
      groups.set(n.id, { x: p.x - p.width / 2, y: p.y - p.height / 2, w: p.width, h: p.height });
    } else {
      nodes.set(n.id, { x: p.x - BOX_W / 2, y: p.y - BOX_H / 2, w: BOX_W, h: BOX_H });
    }
  }
  const all = new Map([...nodes, ...groups]);
  return { nodes, groups, edges: routeEdges(diagram, all), rules: [] };
}
