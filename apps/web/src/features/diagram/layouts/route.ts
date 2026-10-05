import { type Diagram, edgeKey } from "@majhi/shared";
import type { Box, EdgePath, Point } from "../types";

/** Spread between lines that join the same two boxes. */
const BEND = 46;

const centre = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Where the ray from a box's centre toward `target` leaves the box. */
function leave(b: Box, target: Point): Point {
  const c = centre(b);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** Whether the curve from `a` through `via` to `b` passes through any of these boxes. */
function crosses(a: Point, via: Point, b: Point, boxes: readonly Box[]): boolean {
  for (let i = 1; i < 12; i++) {
    const t = i / 12;
    const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * via.x + t * t * b.x;
    const y = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * via.y + t * t * b.y;
    if (boxes.some((k) => x > k.x - 4 && x < k.x + k.w + 4 && y > k.y - 4 && y < k.y + k.h + 4)) return true;
  }
  return false;
}

const quadMid = (a: Point, via: Point, b: Point): Point => ({
  x: (a.x + 2 * via.x + b.x) / 4,
  y: (a.y + 2 * via.y + b.y) / 4,
});

/**
 * The path of every line between the boxes of a layout: from the outline of one box to the outline of the
 * other, bent when several lines join the same pair so each can be read. A line from a box to itself loops
 * out of its right side. A line whose box is missing is left out.
 */
export function routeEdges(
  diagram: Diagram,
  boxes: ReadonlyMap<string, Box>,
  /** What a line must not run through. Default: every box. A layout with group frames passes only the boxes. */
  obstacles: ReadonlyMap<string, Box> = boxes,
): Map<string, EdgePath> {
  const pairs = new Map<string, { key: string; from: string; to: string }[]>();
  diagram.edges.forEach((e, i) => {
    const pair = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    pairs.set(pair, [...(pairs.get(pair) ?? []), { key: edgeKey(e, i), from: e.from, to: e.to }]);
  });
  const out = new Map<string, EdgePath>();
  for (const list of pairs.values()) {
    list.forEach((e, i) => {
      const a = boxes.get(e.from);
      const b = boxes.get(e.to);
      if (a === undefined || b === undefined) return;
      if (e.from === e.to) {
        const loop = 38 + i * 18;
        const start = { x: a.x + a.w, y: a.y + a.h * 0.3 };
        const end = { x: a.x + a.w, y: a.y + a.h * 0.7 };
        const via = { x: a.x + a.w + loop * 1.6, y: a.y + a.h / 2 };
        out.set(e.key, { from: start, via, to: end, mid: { x: a.x + a.w + loop * 1.1, y: a.y + a.h / 2 } });
        return;
      }
      const ca = centre(a);
      const cb = centre(b);
      // The sideways direction is fixed per pair, so a line each way lands on opposite sides.
      const low = e.from < e.to ? ca : cb;
      const high = e.from < e.to ? cb : ca;
      const len = Math.hypot(high.x - low.x, high.y - low.y) || 1;
      const px = -(high.y - low.y) / len;
      const py = (high.x - low.x) / len;
      const offset = list.length === 1 ? 0 : (i - (list.length - 1) / 2) * BEND;
      const mid = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 };
      let via = { x: mid.x + px * offset, y: mid.y + py * offset };
      // A line that would run through another box bows out to the side that is clear.
      const others = [...obstacles.entries()]
        .filter(([id]) => id !== e.from && id !== e.to)
        .map(([, k]) => k);
      if (crosses(ca, via, cb, others)) {
        for (const push of [100, -100, 170, -170, 250, -250]) {
          const tried = { x: mid.x + px * (offset + push), y: mid.y + py * (offset + push) };
          if (!crosses(ca, tried, cb, others)) {
            via = tried;
            break;
          }
        }
      }
      const from = leave(a, via);
      const to = leave(b, via);
      out.set(e.key, { from, via, to, mid: quadMid(from, via, to) });
    });
  }
  return out;
}

/** A straight line between two points, for layouts that place lines themselves (a sequence's messages). */
export function straight(from: Point, to: Point): EdgePath {
  const via = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  return { from, via, to, mid: via };
}
