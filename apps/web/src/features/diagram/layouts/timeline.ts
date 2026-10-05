import type { Diagram } from "@majhi/shared";
import { BOX_H, BOX_W, type Box, type Layout } from "../types";
import { routeEdges } from "./route";

const GAP = BOX_W + 40;
const LIFT = 70;

/**
 * Events in the order given along one horizontal axis, alternately above and below it so neighbours never
 * overlap. Lines, if there are any, join the boxes as usual; the axis itself is a quiet rule.
 */
export const timeline: Layout = (d: Diagram) => {
  const nodes = new Map<string, Box>();
  d.nodes.forEach((n, i) => {
    const above = i % 2 === 0;
    nodes.set(n.id, { x: i * (GAP / 1.4), y: above ? -LIFT - BOX_H : LIFT, w: BOX_W, h: BOX_H });
  });
  const end = Math.max(0, d.nodes.length - 1) * (GAP / 1.4) + BOX_W;
  // A short stem from each event to the axis, so the order reads along the line.
  const stems = d.nodes.flatMap((n) => {
    const b = nodes.get(n.id);
    if (b === undefined) return [];
    const x = b.x + b.w / 2;
    return [{ from: { x, y: b.y < 0 ? b.y + b.h : b.y }, to: { x, y: 0 } }];
  });
  return {
    nodes,
    groups: new Map(),
    edges: routeEdges(d, nodes),
    rules: [{ from: { x: -20, y: 0 }, to: { x: end + 20, y: 0 } }, ...stems],
  };
};
