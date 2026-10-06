import type { Diagram } from "@majhi/shared";
import { BOX_W, type Box, CARD_H, type Layout } from "../types";
import { routeEdges } from "./route";

const COL_GAP = 56;
const ROW_GAP = 16;
const PAD = 16;
const HEAD = 30;
const BAND_GAP = 40;
/** The width over height the finished picture aims for, so it fills a wide canvas instead of a thin column. */
const AIM = 1.5;

/** Highest degree in the middle, the rest alternating above and below it. */
function centreOut<T>(sorted: readonly T[]): T[] {
  const out: T[] = [];
  sorted.forEach((item, i) => {
    if (i % 2 === 0) out.push(item);
    else out.unshift(item);
  });
  return out;
}

/** One group laid out on its own: its size, and where its boxes go relative to its top-left corner. */
interface Band {
  id: string;
  w: number;
  h: number;
  boxes: { id: string; x: number; y: number }[];
}

/**
 * Groups as bands. Inside a band the boxes stand in columns by their `rank` (left to right: an app, the
 * service it calls, the worker behind it, the data), the best connected box of a column in the middle of it.
 * A group whose frame has the kind `pack` holds the boxes with no lines: they are packed in a compact grid.
 * The bands are then dealt into one to four columns, whichever makes the picture closest to a wide canvas.
 * The same diagram always gives the same picture.
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

  const bands: Band[] = [];
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
    const band: Band = {
      id: frame.id,
      w: columns.length * BOX_W + (columns.length - 1) * COL_GAP + PAD * 2,
      h: HEAD + innerH + PAD,
      boxes: [],
    };
    columns.forEach((column, ci) => {
      const colH = column.length * CARD_H + (column.length - 1) * ROW_GAP;
      column.forEach((n, ri) => {
        band.boxes.push({
          id: n.id,
          x: PAD + ci * (BOX_W + COL_GAP),
          y: HEAD + (innerH - colH) / 2 + ri * (CARD_H + ROW_GAP),
        });
      });
    });
    bands.push(band);
  }
  const widest = Math.max(0, ...bands.map((b) => b.w));
  for (const frame of frames.filter((f) => f.kind === "pack")) {
    const inside = members(frame.id);
    if (inside.length === 0) continue;
    const fit = Math.floor((Math.max(widest, 2 * BOX_W + 2 * PAD) - PAD * 2 + ROW_GAP) / (BOX_W + ROW_GAP));
    const cols = Math.max(2, Math.min(fit, inside.length));
    const rows = Math.ceil(inside.length / cols);
    bands.push({
      id: frame.id,
      w: cols * BOX_W + (cols - 1) * ROW_GAP + PAD * 2,
      h: HEAD + rows * CARD_H + (rows - 1) * ROW_GAP + PAD,
      boxes: inside.map((n, i) => ({
        id: n.id,
        x: PAD + (i % cols) * (BOX_W + ROW_GAP),
        y: HEAD + Math.floor(i / cols) * (CARD_H + ROW_GAP),
      })),
    });
  }

  // Deal the bands into columns, each to the shortest one so far; keep the arrangement closest to the aim.
  interface Deal {
    at: Map<string, { x: number; y: number }>;
    w: number;
    h: number;
  }
  const deal = (count: number): Deal => {
    const heights = new Array<number>(count).fill(0);
    const widths = new Array<number>(count).fill(0);
    const placed: { band: Band; col: number; y: number }[] = [];
    for (const band of bands) {
      let col = 0;
      for (let c = 1; c < count; c++) if ((heights[c] ?? 0) < (heights[col] ?? 0)) col = c;
      placed.push({ band, col, y: heights[col] ?? 0 });
      heights[col] = (heights[col] ?? 0) + band.h + BAND_GAP;
      widths[col] = Math.max(widths[col] ?? 0, band.w);
    }
    const left: number[] = [];
    let x = 0;
    for (let c = 0; c < count; c++) {
      left.push(x);
      x += (widths[c] ?? 0) + BAND_GAP;
    }
    const at = new Map<string, { x: number; y: number }>();
    for (const p of placed) at.set(p.band.id, { x: left[p.col] ?? 0, y: p.y });
    return { at, w: x - BAND_GAP, h: Math.max(...heights) - BAND_GAP };
  };
  let best: Deal = deal(1);
  for (let count = 2; count <= Math.min(4, bands.length); count++) {
    const next = deal(count);
    if (Math.abs(Math.log(next.w / next.h / AIM)) < Math.abs(Math.log(best.w / best.h / AIM))) best = next;
  }

  const nodes = new Map<string, Box>();
  const groups = new Map<string, Box>();
  for (const band of bands) {
    const at = best.at.get(band.id) ?? { x: 0, y: 0 };
    groups.set(band.id, { x: at.x, y: at.y, w: band.w, h: band.h });
    for (const b of band.boxes) {
      nodes.set(b.id, { x: at.x + b.x, y: at.y + b.y, w: BOX_W, h: CARD_H });
    }
  }
  // A box that belongs to no group stands under everything.
  const loose = d.nodes.filter((n) => !frameIds.has(n.id) && !nodes.has(n.id));
  loose.forEach((n, i) => {
    nodes.set(n.id, {
      x: i * (BOX_W + ROW_GAP),
      y: (Number.isFinite(best.h) ? best.h : 0) + BAND_GAP,
      w: BOX_W,
      h: CARD_H,
    });
  });
  return { nodes, groups, edges: routeEdges(d, new Map([...nodes, ...groups]), nodes), rules: [] };
};
