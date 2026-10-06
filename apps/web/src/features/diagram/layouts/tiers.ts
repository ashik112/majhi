import { type Diagram, type DiagramNode, edgeKey } from "@majhi/shared";
import { fontsReady, labelSize, nodeSize } from "../measure";
import type { Box, EdgePath, LayoutOptions, Point, Positioned } from "../types";
import { routeEdges } from "./route";

/**
 * A diagram whose every box names its tier (`rank`): the tiers are rows, top to bottom, and the boxes of a tier
 * stand side by side. ELK's layered layout cannot do this, because it never puts two boxes joined by a line in
 * one layer, so the rows are placed here and the lines are routed here, always through the gaps between rows and
 * the lanes beside the drawing, so a line never crosses a box:
 *
 * - a line between neighbouring rows runs down from one box, along a channel in the gap, and down into the other;
 * - a line that skips rows leaves by the gap under its upper box, runs out to a lane at the side, down the lane,
 *   and comes back in through the gap above its lower box;
 * - a line between two boxes of one row is straight when they are neighbours, else a U under the row.
 *
 * Every line that shares a gap gets its own channel, and a channel is chosen so that no label and no line of
 * another runs through a label. The boxes of a row are ordered and spread to sit under and over what they connect.
 */

const MARGIN = 8;
const COL_GAP = 28;
const GAP_PAD = 10;
const MIN_GAP = 30;
const LANE_FIRST = 16;
const LANE_STEP = 12;
const LABEL_AIR = 6;

interface Seg {
  /** The gap under row `gap`. */
  gap: number;
  /** Where the line comes down from the row above, and where it goes down to the row below (x of each vertical). */
  top: number[];
  bottom: number[];
  /** The horizontal part, and the label drawn on it. */
  x0: number;
  x1: number;
  labelW: number;
  labelH: number;
  channel: number;
}

interface Piece {
  edge: number;
  node: string;
  side: "top" | "bottom";
  /** The x this line heads for: ports are ordered by it so lines leave in the order they go. */
  key: number;
  x: number;
}

/** Ids of the nodes of each tier, top to bottom, in the order the writer gave them. */
function rowsOf(d: Diagram): string[][] {
  const tiers = [...new Set(d.nodes.map((n) => n.rank ?? 0))].sort((a, b) => a - b);
  return tiers.map((t) => d.nodes.filter((n) => (n.rank ?? 0) === t).map((n) => n.id));
}

export function tiersApply(d: Diagram): boolean {
  return d.nodes.length > 0 && d.nodes.every((n) => n.rank !== undefined && n.group === undefined);
}

export async function tiers(d: Diagram, { action }: LayoutOptions): Promise<Positioned> {
  await fontsReady();
  const byId = new Map<string, DiagramNode>(d.nodes.map((n) => [n.id, n]));
  const size = new Map(d.nodes.map((n) => [n.id, nodeSize(n, action.has(n.id))]));
  const rows = rowsOf(d);
  const rowOf = new Map<string, number>();
  rows.forEach((ids, r) => {
    for (const id of ids) rowOf.set(id, r);
  });

  // The lines this layout draws; a line from a box to itself and "changes together" are left to the plain router.
  const lines: { index: number; key: string; from: string; to: string; label: { w: number; h: number } }[] =
    [];
  d.edges.forEach((e, i) => {
    if (e.from === e.to || e.type === "together" || !byId.has(e.from) || !byId.has(e.to)) return;
    const l = e.label === undefined ? { w: 0, h: 0 } : labelSize(e);
    lines.push({ index: i, key: edgeKey(e, i), from: e.from, to: e.to, label: l });
  });

  // 1. The order of each row: barycenters over a few sweeps, down and up.
  const order = rows.map((ids) => [...ids]);
  const neighbours = (id: string, row: number): string[] =>
    lines.flatMap((l) => {
      const other = l.from === id ? l.to : l.to === id ? l.from : undefined;
      return other !== undefined && rowOf.get(other) === row ? [other] : [];
    });
  for (let pass = 0; pass < 4; pass++) {
    const down = pass % 2 === 0;
    const rs = order.map((_, r) => r);
    for (const r of down ? rs.slice(1) : rs.slice(0, -1).reverse()) {
      const against = down ? r - 1 : r + 1;
      const at = new Map(order[against]?.map((id, i) => [id, i]));
      const keyed = (order[r] ?? []).map((id, i) => {
        const near = neighbours(id, against).map((n) => at.get(n) ?? 0);
        return { id, key: near.length === 0 ? i : near.reduce((a, b) => a + b, 0) / near.length, i };
      });
      keyed.sort((a, b) => a.key - b.key || a.i - b.i);
      order[r] = keyed.map((k) => k.id);
    }
  }

  // 2. The columns: the gap between neighbours is wide enough for the label of a line that joins them.
  const gapBetween = (a: string, b: string): number => {
    const w = lines
      .filter((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a))
      .reduce((m, l) => Math.max(m, l.label.w), 0);
    return Math.max(COL_GAP, w === 0 ? 0 : w + 20);
  };
  const width = (id: string) => size.get(id)?.w ?? 0;
  const left = new Map<string, number>();
  order.forEach((ids) => {
    let at = 0;
    ids.forEach((id, i) => {
      if (i > 0) at += gapBetween(ids[i - 1] as string, id);
      left.set(id, at);
      at += width(id);
    });
  });
  const rowWidth = (ids: string[]) => {
    const last = ids[ids.length - 1];
    return last === undefined ? 0 : (left.get(last) ?? 0) + width(last);
  };
  const widest = Math.max(...order.map(rowWidth));
  for (const ids of order) {
    const shift = (widest - rowWidth(ids)) / 2;
    for (const id of ids) left.set(id, (left.get(id) ?? 0) + shift);
  }
  const centre = (id: string) => (left.get(id) ?? 0) + width(id) / 2;
  const place = (ids: string[], want: (id: string) => number | undefined) => {
    const desired = ids.map((id) => (want(id) ?? centre(id)) - width(id) / 2);
    const gaps = ids.map((id, i) => (i === 0 ? 0 : gapBetween(ids[i - 1] as string, id)));
    const forward: number[] = [];
    desired.forEach((x, i) => {
      const prev =
        i === 0
          ? Number.NEGATIVE_INFINITY
          : (forward[i - 1] as number) + width(ids[i - 1] as string) + (gaps[i] as number);
      forward.push(Math.max(x, prev));
    });
    const backward: number[] = [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const next =
        i === ids.length - 1
          ? Number.POSITIVE_INFINITY
          : (backward[i + 1] as number) - (gaps[i + 1] as number) - width(ids[i] as string);
      backward[i] = Math.min(desired[i] as number, next);
    }
    ids.forEach((id, i) => {
      left.set(id, ((forward[i] as number) + (backward[i] as number)) / 2);
    });
  };
  for (let pass = 0; pass < 6; pass++) {
    const down = pass % 2 === 0;
    const rs = order.map((_, r) => r);
    for (const r of down ? rs.slice(1) : rs.slice(0, -1).reverse()) {
      const against = down ? r - 1 : r + 1;
      place(order[r] as string[], (id) => {
        const near = neighbours(id, against);
        return near.length === 0 ? undefined : near.reduce((s, n) => s + centre(n), 0) / near.length;
      });
    }
  }
  const minLeft = Math.min(...d.nodes.map((n) => left.get(n.id) ?? 0));
  const maxRight = Math.max(...d.nodes.map((n) => (left.get(n.id) ?? 0) + width(n.id)));
  const mid = (minLeft + maxRight) / 2;

  // 3. What each line is: a straight join, a pair of verticals through one gap, or a trip down a lane.
  const idx = new Map(order.flatMap((ids) => ids.map((id, i) => [id, i] as const)));
  type Plan =
    | { kind: "side"; a: string; b: string }
    | { kind: "gap"; upper: string; lower: string; reversed: boolean }
    | { kind: "lane"; upper: string; lower: string; reversed: boolean; side: -1 | 1; slot: number }
    | { kind: "under"; a: string; b: string };
  const laneCount = { "-1": 0, "1": 0 } as Record<"-1" | "1", number>;
  const plans = lines.map((l): Plan => {
    const ra = rowOf.get(l.from) as number;
    const rb = rowOf.get(l.to) as number;
    if (ra === rb) {
      const adjacent = Math.abs((idx.get(l.from) ?? 0) - (idx.get(l.to) ?? 0)) === 1;
      return adjacent ? { kind: "side", a: l.from, b: l.to } : { kind: "under", a: l.from, b: l.to };
    }
    const reversed = ra > rb;
    const upper = reversed ? l.to : l.from;
    const lower = reversed ? l.from : l.to;
    if ((rowOf.get(lower) as number) - (rowOf.get(upper) as number) === 1)
      return { kind: "gap", upper, lower, reversed };
    const side = (centre(upper) + centre(lower)) / 2 < mid ? -1 : 1;
    const slot = laneCount[String(side) as "-1" | "1"]++;
    return { kind: "lane", upper, lower, reversed, side, slot };
  });
  const laneX = (side: -1 | 1, slot: number) =>
    side === -1 ? minLeft - LANE_FIRST - slot * LANE_STEP : maxRight + LANE_FIRST + slot * LANE_STEP;

  // 4. The ports: where a line leaves or enters the top or bottom of a box, spread by where it is heading.
  const pieces: Piece[] = [];
  plans.forEach((p, i) => {
    if (p.kind === "gap") {
      pieces.push({ edge: i, node: p.upper, side: "bottom", key: centre(p.lower), x: 0 });
      pieces.push({ edge: i, node: p.lower, side: "top", key: centre(p.upper), x: 0 });
    } else if (p.kind === "lane") {
      const x = laneX(p.side, p.slot);
      pieces.push({ edge: i, node: p.upper, side: "bottom", key: x, x: 0 });
      pieces.push({ edge: i, node: p.lower, side: "top", key: x, x: 0 });
    } else if (p.kind === "under") {
      pieces.push({ edge: i, node: p.a, side: "bottom", key: centre(p.b), x: 0 });
      pieces.push({ edge: i, node: p.b, side: "bottom", key: centre(p.a), x: 0 });
    }
  });
  for (const id of byId.keys()) {
    for (const side of ["top", "bottom"] as const) {
      const mine = pieces.filter((q) => q.node === id && q.side === side).sort((a, b) => a.key - b.key);
      mine.forEach((q, i) => {
        q.x = (left.get(id) ?? 0) + (width(id) * (i + 1)) / (mine.length + 1);
      });
    }
  }
  const portX = (edge: number, node: string, side: "top" | "bottom") =>
    pieces.find((q) => q.edge === edge && q.node === node && q.side === side)?.x ?? centre(node);

  // 5. The segments that run along a gap, and the channel of each.
  const segs: { edge: number; seg: Seg; carries: boolean }[] = [];
  plans.forEach((p, i) => {
    const l = lines[i] as (typeof lines)[number];
    const mk = (gap: number, top: number[], bottom: number[], carries: boolean): Seg => {
      const xs = [...top, ...bottom];
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const half = carries ? l.label.w / 2 : 0;
      const m = (x0 + x1) / 2;
      return {
        gap,
        top,
        bottom,
        x0: Math.min(x0, m - half),
        x1: Math.max(x1, m + half),
        labelW: carries ? l.label.w : 0,
        labelH: carries ? l.label.h : 0,
        channel: 0,
      };
    };
    if (p.kind === "gap") {
      segs.push({
        edge: i,
        seg: mk(
          rowOf.get(p.upper) as number,
          [portX(i, p.upper, "bottom")],
          [portX(i, p.lower, "top")],
          true,
        ),
        carries: true,
      });
    } else if (p.kind === "under") {
      segs.push({
        edge: i,
        seg: mk(rowOf.get(p.a) as number, [portX(i, p.a, "bottom"), portX(i, p.b, "bottom")], [], true),
        carries: true,
      });
    } else if (p.kind === "lane") {
      const x = laneX(p.side, p.slot);
      segs.push({
        edge: i,
        seg: mk(rowOf.get(p.upper) as number, [portX(i, p.upper, "bottom")], [x], true),
        carries: true,
      });
      segs.push({
        edge: i,
        seg: mk((rowOf.get(p.lower) as number) - 1, [x], [portX(i, p.lower, "top")], false),
        carries: false,
      });
    }
  });
  const gapCount = Math.max(0, rows.length - 1);
  const channels = Array.from({ length: gapCount }, () => 0);
  const margin = 3;
  const hits = (xs: number[], s: Seg) => xs.some((x) => x > s.x0 - margin && x < s.x1 + margin);
  for (let g = 0; g < gapCount; g++) {
    const here = segs.filter((s) => s.seg.gap === g).sort((a, b) => a.seg.x0 - b.seg.x0);
    const placed: Seg[] = [];
    for (const { seg } of here) {
      let chosen = -1;
      for (let c = 0; c <= placed.length && chosen < 0; c++) {
        const ok = placed.every((t) => {
          if (t.channel === c) return seg.x1 + margin < t.x0 || seg.x0 - margin > t.x1;
          if (t.channel < c) return !hits(seg.top, t) && !hits(t.bottom, seg);
          return !hits(t.top, seg) && !hits(seg.bottom, t);
        });
        if (ok) chosen = c;
      }
      seg.channel = chosen < 0 ? placed.length : chosen;
      placed.push(seg);
    }
    channels[g] = placed.reduce((m, s) => Math.max(m, s.channel + 1), 0);
  }

  // 6. The rows and gaps top to bottom, then every coordinate.
  const rowH = order.map((ids) => Math.max(...ids.map((id) => size.get(id)?.h ?? 0)));
  const slotH = channels.map((_, g) => {
    const tallest = segs.filter((s) => s.seg.gap === g).reduce((m, s) => Math.max(m, s.seg.labelH), 0);
    return Math.max(14, tallest + LABEL_AIR);
  });
  const gapH = channels.map((n, g) =>
    n === 0 ? MIN_GAP : Math.max(MIN_GAP, 2 * GAP_PAD + n * (slotH[g] as number)),
  );
  const rowTop: number[] = [];
  let y = 0;
  rows.forEach((_, r) => {
    rowTop.push(y);
    y += (rowH[r] as number) + (gapH[r] ?? 0);
  });
  const nodes = new Map<string, Box>();
  for (const n of d.nodes) {
    const s = size.get(n.id) as { w: number; h: number };
    const r = rowOf.get(n.id) as number;
    nodes.set(n.id, {
      x: left.get(n.id) ?? 0,
      y: (rowTop[r] as number) + ((rowH[r] as number) - s.h) / 2,
      w: s.w,
      h: s.h,
      fit: true,
    });
  }
  const chY = (g: number, c: number) =>
    (rowTop[g] as number) +
    (rowH[g] as number) +
    GAP_PAD +
    c * (slotH[g] as number) +
    (slotH[g] as number) / 2 +
    ((gapH[g] as number) - 2 * GAP_PAD - (channels[g] as number) * (slotH[g] as number)) / 2;
  const box = (id: string) => nodes.get(id) as Box;
  const edges = new Map<string, EdgePath>();
  const put = (i: number, route: Point[], label: { x: number; y: number } | undefined) => {
    const l = lines[i] as (typeof lines)[number];
    const clean = route.filter(
      (p, k) => k === 0 || p.x !== (route[k - 1] as Point).x || p.y !== (route[k - 1] as Point).y,
    );
    const first = clean[0] as Point;
    const last = clean[clean.length - 1] as Point;
    const labelBox: Box | undefined =
      label === undefined || l.label.w === 0
        ? undefined
        : { x: label.x - l.label.w / 2, y: label.y - l.label.h / 2, w: l.label.w, h: l.label.h };
    const m = label ?? (clean[Math.floor(clean.length / 2)] as Point);
    edges.set(l.key, {
      from: first,
      via: m,
      to: last,
      mid: m,
      route: clean,
      ...(labelBox === undefined ? {} : { label: labelBox }),
    });
  };
  plans.forEach((p, i) => {
    const l = lines[i] as (typeof lines)[number];
    if (p.kind === "side") {
      const a = box(l.from);
      const b = box(l.to);
      const toRight = a.x < b.x;
      const ay = a.y + a.h / 2;
      const p0 = { x: toRight ? a.x + a.w : a.x, y: ay };
      const p1 = { x: toRight ? b.x : b.x + b.w, y: b.y + b.h / 2 };
      const cx = (p0.x + p1.x) / 2;
      const cy = (p0.y + p1.y) / 2;
      put(i, p0.y === p1.y ? [p0, p1] : [p0, { x: cx, y: p0.y }, { x: cx, y: p1.y }, p1], { x: cx, y: cy });
      return;
    }
    if (p.kind === "under") {
      const s = segs.find((q) => q.edge === i) as { seg: Seg };
      const cy = chY(s.seg.gap, s.seg.channel);
      const a = box(l.from);
      const b = box(l.to);
      const xa = portX(i, l.from, "bottom");
      const xb = portX(i, l.to, "bottom");
      put(
        i,
        [
          { x: xa, y: a.y + a.h },
          { x: xa, y: cy },
          { x: xb, y: cy },
          { x: xb, y: b.y + b.h },
        ],
        { x: (xa + xb) / 2, y: cy },
      );
      return;
    }
    const up = box(p.upper);
    const lo = box(p.lower);
    const xu = portX(i, p.upper, "bottom");
    const xl = portX(i, p.lower, "top");
    let route: Point[];
    let label: { x: number; y: number };
    if (p.kind === "gap") {
      const s = segs.find((q) => q.edge === i) as { seg: Seg };
      const cy = chY(s.seg.gap, s.seg.channel);
      route = [
        { x: xu, y: up.y + up.h },
        { x: xu, y: cy },
        { x: xl, y: cy },
        { x: xl, y: lo.y },
      ];
      label = { x: (xu + xl) / 2, y: cy };
    } else {
      const mine = segs.filter((q) => q.edge === i);
      const first = (mine[0] as { seg: Seg }).seg;
      const second = (mine[1] as { seg: Seg }).seg;
      const lane = laneX(p.side, p.slot);
      const y1 = chY(first.gap, first.channel);
      const y2 = chY(second.gap, second.channel);
      route = [
        { x: xu, y: up.y + up.h },
        { x: xu, y: y1 },
        { x: lane, y: y1 },
        { x: lane, y: y2 },
        { x: xl, y: y2 },
        { x: xl, y: lo.y },
      ];
      label = { x: (xu + lane) / 2, y: y1 };
    }
    put(i, p.reversed ? route.reverse() : route, label);
  });

  // 7. Everything starts at the margin; the lines left to the plain router are added.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const b of nodes.values()) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
  }
  for (const e of edges.values()) {
    for (const p of e.route ?? []) minX = Math.min(minX, p.x);
    if (e.label !== undefined) minX = Math.min(minX, e.label.x);
  }
  const dx = MARGIN - minX;
  const dy = MARGIN - minY;
  const mv = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  const moved = new Map<string, Box>([...nodes].map(([id, b]) => [id, { ...b, x: b.x + dx, y: b.y + dy }]));
  const movedEdges = new Map<string, EdgePath>(
    [...edges].map(([k, e]) => [
      k,
      {
        from: mv(e.from),
        via: mv(e.via),
        to: mv(e.to),
        mid: mv(e.mid),
        ...(e.route === undefined ? {} : { route: e.route.map(mv) }),
        ...(e.label === undefined ? {} : { label: { ...e.label, x: e.label.x + dx, y: e.label.y + dy } }),
      },
    ]),
  );
  for (const [key, p] of routeEdges(d, moved, moved)) if (!movedEdges.has(key)) movedEdges.set(key, p);
  return { nodes: moved, groups: new Map(), edges: movedEdges, rules: [] };
}
