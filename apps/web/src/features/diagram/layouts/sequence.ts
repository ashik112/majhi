import { type Diagram, edgeKey } from "@majhi/shared";
import { BOX_H, BOX_W, type Box, type EdgePath, type Layout, type Rule } from "../types";
import { straight } from "./route";

const LANE = BOX_W + 56;
/** Space between two messages. */
const STEP = 58;

/**
 * Lanes per actor, left to right (`actors` sets the order, then the rest as given), and the edges in the order
 * given as messages from top to bottom. A message to the same actor loops back on its lane. Each lane has a
 * dashed lifeline under its box.
 */
export const sequence: Layout = (d: Diagram) => {
  const order = [
    ...(d.actors ?? []),
    ...d.nodes.map((n) => n.id).filter((id) => !(d.actors ?? []).includes(id)),
  ];
  const nodes = new Map<string, Box>();
  order.forEach((id, i) => {
    nodes.set(id, { x: i * LANE, y: 0, w: BOX_W, h: BOX_H });
  });
  const first = BOX_H + 44;
  const lane = (id: string) => (nodes.get(id)?.x ?? 0) + BOX_W / 2;
  const edges = new Map<string, EdgePath>();
  d.edges.forEach((e, i) => {
    const y = first + i * STEP;
    if (e.from === e.to) {
      // Out and back on the same lane: a small loop to the right of it.
      const x = lane(e.from);
      edges.set(edgeKey(e, i), {
        from: { x, y: y - 10 },
        via: { x: x + 90, y },
        to: { x, y: y + 10 },
        mid: { x: x + 68, y },
      });
      return;
    }
    edges.set(edgeKey(e, i), straight({ x: lane(e.from), y }, { x: lane(e.to), y }));
  });
  const bottom = first + Math.max(1, d.edges.length) * STEP;
  const rules: Rule[] = order.map((id) => ({
    from: { x: lane(id), y: BOX_H },
    to: { x: lane(id), y: bottom },
    dash: "4 6",
  }));
  return { nodes, groups: new Map(), edges, rules };
};
