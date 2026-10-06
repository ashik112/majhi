import { type Diagram, type DiagramNode, edgeKey } from "@majhi/shared";
import { TYPE, textWidth, withoutStepNumber, wrappedLines } from "../measure";
import type { Box, EdgePath, Layout, Point, Positioned, Rule } from "../types";
import { straight } from "./route";

/** An actor box is narrower than other boxes: a lane is a column, and a message needs room between two of them. */
export const ACTOR_W = 128;
const LANE = ACTOR_W + 20;
/** Space between two messages. */
const STEP = 72;
/** The loop a message to the same actor makes, to the right of its lane; its number sits on the loop's tip. */
const LOOP_W = 40;
/** The widest a loop's label is, and the room the loop and its label take to the right of the lane. */
const LOOP_LABEL_W = 170;
const LOOP_ROOM = LOOP_W + 16 + LOOP_LABEL_W;
/** The space around the drawing, so no box or arrow touches the frame. */
export const SEQUENCE_PAD = 12;
/** Lanes spread out to fill a wide frame, but never past this much of their natural distance. */
const MAX_SPREAD = 1.45;
/** A label sits this far above its line, which the number on the line also needs. */
const LABEL_LIFT = 12;
const LABEL_PAD = 4;

const ACTOR_PAD_Y = 8;

function actorHeight(nodes: readonly DiagramNode[]): number {
  const inner = ACTOR_W - 16 - 6;
  const tallest = Math.max(
    0,
    ...nodes.map(
      (n) =>
        wrappedLines(n.label, TYPE.title.font, inner) * TYPE.title.line +
        (n.sub === undefined ? 0 : wrappedLines(n.sub, TYPE.sub.font, inner) * TYPE.sub.line),
    ),
  );
  return Math.max(48, tallest + 2 * ACTOR_PAD_Y);
}

/** The words of a message: as wide as they are, up to `max`, and the lines they take. */
function words(text: string, max: number): { w: number; h: number } {
  const w = Math.min(max, Math.ceil(textWidth(text, TYPE.label.font)) + 8);
  return { w, h: wrappedLines(text, TYPE.label.font, w - 6) * TYPE.label.line + 2 * LABEL_PAD };
}

/** The distance between the two lanes a message runs between, or the room to the right of its lane. */
function laneSpan(order: readonly string[], e: Diagram["edges"][number]): number {
  const a = order.indexOf(e.from);
  const b = order.indexOf(e.to);
  return e.from === e.to ? LOOP_LABEL_W : Math.abs(b - a) * LANE;
}

/**
 * Lanes per actor, left to right (`actors` sets the order, then the rest as given), and the edges in the order
 * given as messages from top to bottom. A message to the same actor loops back on its lane. Each lane has a
 * dashed lifeline under its box. Every message carries the box of its words, above its line, so the words
 * never run into a lane or the loop. The lanes are as close as a message can still be read; `fitSequence`
 * spreads them over a wide frame.
 */
export const sequence: Layout = (d: Diagram) => {
  const order = [
    ...(d.actors ?? []),
    ...d.nodes.map((n) => n.id).filter((id) => !(d.actors ?? []).includes(id)),
  ];
  const head = actorHeight(d.nodes);
  // The first message's words sit above its line, clear of the actor boxes.
  const firstLabel = d.edges[0]?.label;
  const aboveFirst =
    firstLabel === undefined || d.edges[0] === undefined
      ? 0
      : words(withoutStepNumber(firstLabel), Math.max(40, laneSpan(order, d.edges[0]) - 16)).h +
        LABEL_LIFT +
        8;
  const first = head + Math.max(44, aboveFirst);
  const nodes = new Map<string, Box>();
  order.forEach((id, i) => {
    nodes.set(id, { x: i * LANE, y: 0, w: ACTOR_W, h: head, fit: true });
  });
  const lane = (id: string) => (nodes.get(id)?.x ?? 0) + ACTOR_W / 2;
  const edges = new Map<string, EdgePath>();
  d.edges.forEach((e, i) => {
    const y = first + i * STEP;
    if (e.from === e.to) {
      const x = lane(e.from);
      const text = e.label === undefined ? undefined : words(withoutStepNumber(e.label), LOOP_LABEL_W);
      const out: Point = { x, y: y - 11 };
      const back: Point = { x, y: y + 11 };
      edges.set(edgeKey(e, i), {
        from: out,
        via: { x: x + LOOP_W, y },
        to: back,
        mid: { x: x + LOOP_W, y },
        route: [out, { x: x + LOOP_W, y: y - 11 }, { x: x + LOOP_W, y: y + 11 }, back],
        ...(text === undefined
          ? {}
          : { label: { x: x + LOOP_W + 16, y: y - text.h / 2, w: text.w, h: text.h } }),
      });
      return;
    }
    const a = lane(e.from);
    const b = lane(e.to);
    const path = straight({ x: a, y }, { x: b, y });
    const text = e.label === undefined ? undefined : words(withoutStepNumber(e.label), Math.abs(b - a) - 16);
    edges.set(edgeKey(e, i), {
      ...path,
      ...(text === undefined
        ? {}
        : { label: { x: (a + b) / 2 - text.w / 2, y: y - LABEL_LIFT - text.h, w: text.w, h: text.h } }),
    });
  });
  const bottom = first + Math.max(1, d.edges.length) * STEP;
  const rules: Rule[] = order.map((id) => ({
    from: { x: lane(id), y: head },
    to: { x: lane(id), y: bottom },
    dash: "4 6",
  }));
  return { nodes, groups: new Map(), edges, rules } satisfies Positioned;
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
      edges.set(key, {
        from: shift(p.from),
        via: shift(p.via),
        to: shift(p.to),
        mid: shift(p.mid),
        ...(p.route === undefined ? {} : { route: p.route.map(shift) }),
        ...(p.label === undefined ? {} : { label: { ...p.label, x: p.label.x + dx } }),
      });
    } else {
      edges.set(key, {
        from: move(p.from),
        via: move(p.via),
        to: move(p.to),
        mid: move(p.mid),
        ...(p.label === undefined
          ? {}
          : { label: { ...p.label, x: (p.label.x + p.label.w / 2) * spread - p.label.w / 2 } }),
      });
    }
  }
  const rules = laid.rules.map((r) => ({ ...r, from: move(r.from), to: move(r.to) }));
  const positioned = { nodes, groups: laid.groups, edges, rules };
  return { positioned, width: right(spread), height: height(laid) };
}

function height(laid: Positioned): number {
  return laid.rules.reduce((h, r) => Math.max(h, r.to.y), 0) + 8;
}

/** How tall a frame must be to show a whole sequence of `messages` messages without scrolling down. */
export function sequenceHeight(messages: number, actors: readonly DiagramNode[]): number {
  return actorHeight(actors) + 72 + Math.max(1, messages) * STEP + 8 + 2 * SEQUENCE_PAD;
}
