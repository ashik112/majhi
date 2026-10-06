import type { Diagram } from "@majhi/shared";
import { BOX_W, type Box, CARD_H, type Layout } from "../types";
import { routeEdges } from "./route";

const COL_GAP = 72;
const ROW_GAP = 16;
const PAD = 16;
const HEAD = 30;
const BAND_GAP = 44;

/** Highest degree in the middle, the rest alternating above and below it. */
function centreOut<T>(sorted: readonly T[]): T[] {
  const out: T[] = [];
  sorted.forEach((item, i) => {
    if (i % 2 === 0) out.push(item);
    else out.unshift(item);
  });
  return out;
}

/**
 * Groups as bands, one under the other. Inside a band the boxes stand in columns by their `rank` (left to
 * right: an app, the service it calls, the worker behind it, the data), the best connected box of a column in
 * the middle of it. A group whose frame has the kind `pack` holds the boxes with no lines: they are packed in
 * a compact grid under the others. The same diagram always gives the same picture.
 */
export const lanes: Layout = (d: Diagram) => {
  const frames = d.nodes.filter((n) => d.nodes.some((m) => m.group === n.id));
  const frameIds = new Set(frames.map((f) => f.id));
  const degree = new Map<string, number>();
  for (const e of d.edges) {
    if (e.from === e.to || e.type === "together") continue;
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const deg = (id: string) => degree.get(id) ?? 0;
  const members = (frame: string) => d.nodes.filter((n) => n.group === frame && !frameIds.has(n.id));

  const nodes = new Map<string, Box>();
  const groups = new Map<string, Box>();
  let y = 0;
  let widest = 0;
  for (const frame of frames.filter((f) => f.kind !== "pack")) {
    const inside = members(frame.id);
    if (inside.length === 0) continue;
    const ranks = [...new Set(inside.map((n) => n.rank ?? 0))].toSorted((a, b) => a - b);
    const columns = ranks.map((r) =>
      centreOut(
        inside
          .filter((n) => (n.rank ?? 0) === r)
          .toSorted((a, b) => deg(b.id) - deg(a.id) || a.id.localeCompare(b.id)),
      ),
    );
    const tallest = Math.max(...columns.map((c) => c.length));
    const innerH = tallest * CARD_H + (tallest - 1) * ROW_GAP;
    const w = columns.length * BOX_W + (columns.length - 1) * COL_GAP + PAD * 2;
    const h = HEAD + innerH + PAD;
    groups.set(frame.id, { x: 0, y, w, h });
    columns.forEach((column, ci) => {
      const colH = column.length * CARD_H + (column.length - 1) * ROW_GAP;
      column.forEach((n, ri) => {
        nodes.set(n.id, {
          x: PAD + ci * (BOX_W + COL_GAP),
          y: y + HEAD + (innerH - colH) / 2 + ri * (CARD_H + ROW_GAP),
          w: BOX_W,
          h: CARD_H,
        });
      });
    });
    widest = Math.max(widest, w);
    y += h + BAND_GAP;
  }

  for (const frame of frames.filter((f) => f.kind === "pack")) {
    const inside = members(frame.id);
    if (inside.length === 0) continue;
    const fit = Math.floor((Math.max(widest, 3 * BOX_W) - PAD * 2 + ROW_GAP) / (BOX_W + ROW_GAP));
    const cols = Math.max(2, Math.min(fit, inside.length));
    const rows = Math.ceil(inside.length / cols);
    const w = cols * BOX_W + (cols - 1) * ROW_GAP + PAD * 2;
    const h = HEAD + rows * CARD_H + (rows - 1) * ROW_GAP + PAD;
    groups.set(frame.id, { x: 0, y, w, h });
    inside.forEach((n, i) => {
      nodes.set(n.id, {
        x: PAD + (i % cols) * (BOX_W + ROW_GAP),
        y: y + HEAD + Math.floor(i / cols) * (CARD_H + ROW_GAP),
        w: BOX_W,
        h: CARD_H,
      });
    });
    y += h + BAND_GAP;
  }

  // A box that belongs to no group stands under everything.
  const loose = d.nodes.filter((n) => !frameIds.has(n.id) && !nodes.has(n.id));
  loose.forEach((n, i) => {
    nodes.set(n.id, { x: i * (BOX_W + ROW_GAP), y, w: BOX_W, h: CARD_H });
  });
  return { nodes, groups, edges: routeEdges(d, new Map([...nodes, ...groups]), nodes), rules: [] };
};
