import { Graph, layout } from "@dagrejs/dagre";
import type { Diagram, DiagramNode } from "@majhi/shared";
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

/** Room inside a group's frame: around its boxes, and for its name on top. */
const PAD = 16;
const HEAD = 30;
const GAP = 14;

interface Size {
  w: number;
  h: number;
}

/**
 * Layers by dagre. A group is one unit to dagre, sized from the boxes inside it (stacked in a column, a group
 * in a group the same way), and the boxes are then placed inside its frame. Lines are laid out between
 * the top units, so a line from a box in one group to a box in another orders the groups. Flow, top-down,
 * tree and state use this with different directions and spacing.
 */
export function layered(diagram: Diagram, options: LayeredOptions): Positioned {
  const containers = containersOf(diagram);
  const byId = new Map<string, DiagramNode>(diagram.nodes.map((n) => [n.id, n]));
  const kids = new Map<string | undefined, string[]>();
  for (const n of diagram.nodes) {
    // A group that does not exist is no group: the box stands on its own.
    const parent = n.group !== undefined && byId.has(n.group) ? n.group : undefined;
    kids.set(parent, [...(kids.get(parent) ?? []), n.id]);
  }
  const sizes = new Map<string, Size>();
  const measure = (id: string): Size => {
    const known = sizes.get(id);
    if (known !== undefined) return known;
    let size: Size = { w: BOX_W, h: BOX_H };
    if (containers.has(id)) {
      const inner = (kids.get(id) ?? []).map(measure);
      size = {
        w: Math.max(BOX_W, ...inner.map((s) => s.w)) + PAD * 2,
        h: HEAD + inner.reduce((sum, s) => sum + s.h, 0) + Math.max(0, inner.length - 1) * GAP + PAD,
      };
    }
    sizes.set(id, size);
    return size;
  };

  const top = kids.get(undefined) ?? [];
  const topOf = (id: string): string => {
    let at = id;
    for (let n = byId.get(at)?.group; n !== undefined && byId.has(n); n = byId.get(at)?.group) at = n;
    return at;
  };
  const g = new Graph();
  g.setGraph({
    rankdir: options.rankdir,
    nodesep: options.nodesep,
    ranksep: options.ranksep,
    marginx: 24,
    marginy: 34,
    ...(options.ranker === undefined ? {} : { ranker: options.ranker }),
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of top) g.setNode(id, { width: measure(id).w, height: measure(id).h });
  for (const e of diagram.edges) {
    if (e.from === e.to || e.type === "together") continue;
    const a = topOf(e.from);
    const b = topOf(e.to);
    if (a !== b && byId.has(e.from) && byId.has(e.to)) g.setEdge(a, b);
  }
  layout(g);

  const nodes = new Map<string, Box>();
  const groups = new Map<string, Box>();
  const place = (id: string, x: number, y: number): void => {
    const size = measure(id);
    if (!containers.has(id)) {
      nodes.set(id, { x, y, w: size.w, h: size.h });
      return;
    }
    groups.set(id, { x, y, w: size.w, h: size.h });
    let cursor = y + HEAD;
    for (const child of kids.get(id) ?? []) {
      const s = measure(child);
      place(child, x + (size.w - s.w) / 2, cursor);
      cursor += s.h + GAP;
    }
  };
  for (const id of top) {
    const p = g.node(id);
    place(id, p.x - p.width / 2, p.y - p.height / 2);
  }
  return { nodes, groups, edges: routeEdges(diagram, new Map([...nodes, ...groups]), nodes), rules: [] };
}
