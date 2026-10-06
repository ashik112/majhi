import { type Diagram, edgeKey } from "@majhi/shared";
import {
  BOX_H,
  type Box,
  type EdgePath,
  type Layout,
  type Point,
  type Positioned,
  type Rule,
} from "../types";
import { straight } from "./route";

/** An actor box is narrower than other boxes: a lane is a column, and a message needs room between two of them. */
export const ACTOR_W = 118;
const LANE = ACTOR_W + 14;
/** Space between two messages. */
const STEP = 68;
/** The room a message that loops back on its lane takes to the right of the lane: the loop, its number and its label. */
const LOOP_W = 46;
const LOOP_ROOM = LOOP_W + 200;
/** The space around the drawing, so no box or arrow touches the frame. */
export const SEQUENCE_PAD = 12;
/** Lanes spread out to fill a wide frame, but never past this much of their natural distance. */
const MAX_SPREAD = 1.45;

const first = BOX_H + 56;

/**
 * Lanes per actor, left to right (`actors` sets the order, then the rest as given), and the edges in the order
 * given as messages from top to bottom. A message to the same actor loops back on its lane. Each lane has a
 * dashed lifeline under its box. The lanes are as close as a message can still be read; `fitSequence` spreads
 * them over a wide frame.
 */
export const sequence: Layout = (d: Diagram) => {
  const order = [
    ...(d.actors ?? []),
    ...d.nodes.map((n) => n.id).filter((id) => !(d.actors ?? []).includes(id)),
  ];
  const nodes = new Map<string, Box>();
  order.forEach((id, i) => {
    nodes.set(id, { x: i * LANE, y: 0, w: ACTOR_W, h: BOX_H });
  });
  const lane = (id: string) => (nodes.get(id)?.x ?? 0) + ACTOR_W / 2;
  const edges = new Map<string, EdgePath>();
  d.edges.forEach((e, i) => {
    const y = first + i * STEP;
    if (e.from === e.to) {
      // Out and back on the same lane: a small loop to the right of it. The number sits on its tip.
      const x = lane(e.from);
      edges.set(edgeKey(e, i), {
        from: { x, y: y - 10 },
        via: { x: x + 2 * LOOP_W, y },
        to: { x, y: y + 10 },
        mid: { x: x + LOOP_W, y },
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

const isLoop = (p: EdgePath) => p.from.x === p.to.x;

/** A sequence laid out for a frame: where everything goes, and how big the drawing is without its padding. */
export interface FittedSequence {
  positioned: Positioned;
  width: number;
  height: number;
}

/**
 * Spreads the lanes of a sequence over `available` pixels of width, when there is room to spare. When there is
 * not, the lanes stay as close as they were laid out and `width` is more than `available`: the frame scrolls
 * sideways, the text never shrinks. Pure, so the cached layout is reused for every frame width.
 */
export function fitSequence(laid: Positioned, available: number): FittedSequence {
  const right = (spread: number) => {
    let r = 0;
    for (const b of laid.nodes.values()) r = Math.max(r, (b.x + b.w / 2) * spread + b.w / 2);
    for (const p of laid.edges.values()) if (isLoop(p)) r = Math.max(r, p.from.x * spread + LOOP_ROOM);
    return r;
  };
  const natural = right(1);
  const lastLane = Math.max(1, ...[...laid.nodes.values()].map((b) => b.x + b.w / 2));
  const spread = Math.min(MAX_SPREAD, Math.max(1, 1 + (available - natural) / lastLane));
  if (spread === 1) {
    return { positioned: laid, width: natural, height: height(laid) };
  }
  const move = (p: Point): Point => ({ x: p.x * spread, y: p.y });
  const nodes = new Map<string, Box>();
  for (const [id, b] of laid.nodes) nodes.set(id, { ...b, x: (b.x + b.w / 2) * spread - b.w / 2 });
  const edges = new Map<string, EdgePath>();
  for (const [key, p] of laid.edges) {
    if (isLoop(p)) {
      const dx = p.from.x * spread - p.from.x;
      const shift = (q: Point): Point => ({ x: q.x + dx, y: q.y });
      edges.set(key, { from: shift(p.from), via: shift(p.via), to: shift(p.to), mid: shift(p.mid) });
    } else {
      edges.set(key, { from: move(p.from), via: move(p.via), to: move(p.to), mid: move(p.mid) });
    }
  }
  const rules = laid.rules.map((r) => ({ ...r, from: move(r.from), to: move(r.to) }));
  const positioned = { nodes, groups: laid.groups, edges, rules };
  return { positioned, width: right(spread), height: height(laid) };
}

function height(laid: Positioned): number {
  return laid.rules.reduce((h, r) => Math.max(h, r.to.y), BOX_H) + 8;
}

/** How tall a frame must be to show a whole sequence of `messages` messages without scrolling down. */
export function sequenceHeight(messages: number): number {
  return first + Math.max(1, messages) * STEP + 8 + 2 * SEQUENCE_PAD;
}
