import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { Graph, PNode } from "./model";

/**
 * Where everything goes on the Map page. All three layouts are pure: the same map gives the same places,
 * and they run only when the map's structure changes (never for a hover, a pick or a pan).
 */

export type Pt = readonly [number, number];

export interface Place {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverviewLayout {
  w: number;
  h: number;
  nodes: Map<string, Place>;
  routes: Map<string, Pt[]>;
  /** The lane titles and where each starts. */
  tags: { text: string; x: number }[];
}

const CHAR_W = 8.2;
const MIN_W = 120;
const MAX_W = 196;
const CHIP_GAP = 4;

/** A box's width from its longest text, and its height from how many rows of chips it needs. */
export function boxSize(n: PNode): { w: number; h: number } {
  const chips = [...n.stores, ...n.outside];
  const widest = Math.max(n.label.length * CHAR_W + 24, ...chips.map((c) => c.length * 6.8 + 22));
  const w = Math.min(MAX_W, Math.max(MIN_W, Math.round(widest)));
  let rows = 1;
  let used = 0;
  for (const c of chips) {
    const cw = c.length * 6.8 + 14 + CHIP_GAP;
    if (used + cw > w - 22 && used > 0) {
      rows += 1;
      used = 0;
    }
    used += cw;
  }
  return { w, h: 76 + 25 * Math.min(rows, 3) };
}

/** The structure the layout depends on. Two maps with the same key lay out the same. */
export function overviewKey(g: Graph): string {
  return JSON.stringify([
    g.connected.map((n) => [n.id, n.lane, boxSize(n)]),
    g.edges.filter((e) => g.byId.get(e.from)?.connected).map((e) => [e.id, e.from, e.to]),
  ]);
}

const cache = new Map<string, OverviewLayout>();
type ElkClass = new () => { layout(graph: ElkNode): Promise<ElkNode> };
let elk: Promise<InstanceType<ElkClass>> | undefined;

function engine() {
  elk ??= import("elkjs/lib/elk.bundled.js").then((m) => new (m.default as unknown as ElkClass)());
  return elk;
}

/**
 * The Overview: left to right in the four lanes, ELK's layered layout with orthogonal routing, each box held
 * in its lane by a partition so a lane never lands left of the one before it.
 */
export async function layoutOverview(g: Graph): Promise<OverviewLayout> {
  const key = overviewKey(g);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const sizes = new Map(g.connected.map((n) => [n.id, boxSize(n)]));
  const ids = new Set(g.connected.map((n) => n.id));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.partitioning.activate": "true",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.layered.spacing.edgeNodeBetweenLayers": "26",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
      "elk.spacing.nodeNode": "34",
      "elk.spacing.edgeEdge": "14",
      "elk.spacing.edgeNode": "20",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.crossingMinimization.semiInteractive": "false",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
    children: g.connected.map((n) => ({
      id: n.id,
      width: sizes.get(n.id)?.w ?? MIN_W,
      height: sizes.get(n.id)?.h ?? 100,
      layoutOptions: { "elk.partitioning.partition": String(n.lane) },
    })),
    edges: g.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const done = await (await engine()).layout(graph);
  const nodes = new Map<string, Place>();
  for (const c of done.children ?? []) {
    nodes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? MIN_W, h: c.height ?? 100 });
  }
  const routes = new Map<string, Pt[]>();
  for (const e of done.edges ?? []) {
    const edge = e as ElkExtendedEdge;
    const sec = edge.sections?.[0];
    if (sec === undefined) continue;
    routes.set(edge.id, [
      [sec.startPoint.x, sec.startPoint.y],
      ...(sec.bendPoints ?? []).map((p): Pt => [p.x, p.y]),
      [sec.endPoint.x, sec.endPoint.y],
    ]);
  }
  // Lane titles sit over the left edge of each lane's boxes.
  const tags: { text: string; x: number }[] = [];
  for (const [i, text] of ["Apps", "Services", "Queue", "Workers"].entries()) {
    const members = g.connected.filter((n) => n.lane === i);
    if (members.length === 0) continue;
    const x = Math.min(...members.map((n) => nodes.get(n.id)?.x ?? 0));
    const wide = i === 2 && members.some((n) => n.roleClass !== "queue");
    tags.push({ text: wide ? "Queue and data" : text, x });
  }
  const right = Math.max(0, ...[...nodes.values()].map((p) => p.x + p.w));
  const bottom = Math.max(0, ...[...nodes.values()].map((p) => p.y + p.h));
  const out: OverviewLayout = { w: Math.ceil(right), h: Math.ceil(bottom), nodes, routes, tags };
  if (cache.size > 20) cache.clear();
  cache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Paths

/** A path through the points with rounded corners. */
export function roundPath(pts: readonly Pt[], r = 10): string {
  const first = pts[0];
  if (first === undefined) return "";
  let d = `M${first[0]} ${first[1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1] as Pt;
    const [x, y] = pts[i] as Pt;
    const [nx, ny] = pts[i + 1] as Pt;
    const l1 = Math.hypot(x - px, y - py);
    const l2 = Math.hypot(nx - x, ny - y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = x - ((x - px) / l1) * rr;
    const ay = y - ((y - py) / l1) * rr;
    const bx = x + ((nx - x) / l2) * rr;
    const by = y + ((ny - y) / l2) * rr;
    d += ` L${ax} ${ay} Q${x} ${y} ${bx} ${by}`;
  }
  const last = pts[pts.length - 1] as Pt;
  return `${d} L${last[0]} ${last[1]}`;
}

function ends(pts: readonly Pt[]): { x: number; y: number; px: number; py: number; l: number } {
  const [x, y] = pts[pts.length - 1] as Pt;
  const [px, py] = (pts[pts.length - 2] ?? pts[0]) as Pt;
  return { x, y, px, py, l: Math.hypot(x - px, y - py) || 1 };
}

export function arrowOf(pts: readonly Pt[]): string {
  const { x, y, px, py, l } = ends(pts);
  const dx = (x - px) / l;
  const dy = (y - py) / l;
  const bx = x - dx * 8;
  const by = y - dy * 8;
  const nx = -dy * 4.2;
  const ny = dx * 4.2;
  return `M${x} ${y} L${bx + nx} ${by + ny} L${bx - nx} ${by - ny}Z`;
}

/** The points with the last one pulled back so the line does not poke through the arrow head. */
export function shorten(pts: readonly Pt[]): Pt[] {
  const c = pts.map((p): Pt => [p[0], p[1]]);
  const { x, y, px, py, l } = ends(pts);
  c[c.length - 1] = [x - ((x - px) / l) * 7, y - ((y - py) / l) * 7];
  return c;
}

/** The middle of the longest segment: where a hover label sits. */
export function longestMid(pts: readonly Pt[]): Pt {
  let best = 0;
  let mid: Pt = pts[0] as Pt;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) {
      best = l;
      mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
  }
  return mid;
}

/** Where a step's number sits: a little before the arrow head. */
export function badgePos(pts: readonly Pt[]): Pt {
  const { x, y, px, py, l } = ends(pts);
  const d = Math.min(24, l / 2);
  return [x - ((x - px) / l) * d, y - ((y - py) / l) * d];
}

// ---------------------------------------------------------------------------
// Project view

export interface ProjectLayout {
  w: number;
  h: number;
  /** Used-by boxes (left) and talks-to boxes (right), each with the line it stands for. */
  left: { edge: string; node: string; y: number }[];
  right: { edge: string; node: string; y: number }[];
  routes: Map<string, Pt[]>;
  card: Place;
  size: { cw: number; ch: number; mw: number; rx: number };
}

/** Used by on the left, the project in the middle, Talks to on the right; the card as tall as the stacks. */
export function layoutProject(g: Graph, id: string): ProjectLayout {
  const ins = g.ins(id);
  const outs = g.outs(id);
  const cw = 164;
  const ch = 80;
  const gap = 16;
  const mw = 248;
  const cg = 44;
  const stack = (n: number) => n * ch + Math.max(0, n - 1) * gap;
  const h = Math.max(380, stack(Math.max(ins.length, outs.length, 1)) + 48);
  const cx = cw + cg;
  const rx = cx + mw + cg;
  const routes = new Map<string, Pt[]>();
  const y0i = (h - stack(ins.length)) / 2;
  const y0o = (h - stack(outs.length)) / 2;
  const left = ins.map((e, k) => {
    const y = y0i + k * (ch + gap);
    routes.set(e.id, [
      [cw, y + ch / 2],
      [cx, y + ch / 2],
    ]);
    return { edge: e.id, node: e.from, y };
  });
  const right = outs.map((e, k) => {
    const y = y0o + k * (ch + gap);
    routes.set(e.id, [
      [cx + mw, y + ch / 2],
      [rx, y + ch / 2],
    ]);
    return { edge: e.id, node: e.to, y };
  });
  return {
    w: rx + cw,
    h,
    left,
    right,
    routes,
    card: { x: cx, y: 0, w: mw, h },
    size: { cw, ch, mw, rx },
  };
}

// ---------------------------------------------------------------------------
// Journeys

export interface JourneyLayout {
  w: number;
  h: number;
  actors: string[];
  x: (id: string) => number;
  pitch: number;
  hw: number;
  head: number;
  row: number;
}

/** A sequence diagram: one lane per box in the order the journey reaches it, one row per step. */
export function layoutJourney(steps: readonly { from: string; to: string }[]): JourneyLayout {
  const actors: string[] = [];
  for (const s of steps) for (const id of [s.from, s.to]) if (!actors.includes(id)) actors.push(id);
  const pitch = actors.length <= 4 ? 170 : 112;
  const hw = pitch - 10;
  const head = 96;
  const row = 68;
  return {
    w: pitch * actors.length - (pitch - hw),
    h: head + 30 + steps.length * row,
    actors,
    x: (id) => hw / 2 + actors.indexOf(id) * pitch,
    pitch,
    hw,
    head,
    row,
  };
}
