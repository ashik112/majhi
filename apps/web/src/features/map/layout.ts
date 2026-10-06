import type { InsideSpec } from "@majhi/shared";
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
  /** Lines that cross each other in this picture. */
  crossings: number;
}

const CHAR_W = 9.3;
const MIN_W = 112;
const MAX_W = 196;
const CHIP_GAP = 4;

/** A box's width from its longest text, and its height from how many rows of chips it needs. */
export function boxSize(n: PNode): { w: number; h: number } {
  const chips = [...n.stores, ...n.outside].map(() => 28 + CHIP_GAP);
  // The badge and the state word share the first row.
  const state =
    n.lamp === "idle" ? 0 : 18 + (n.lamp === "working" ? 7 : n.lampWord === "needs you" ? 9 : 8) * 8;
  const head = 28 + state + 8;
  const row = Math.min(MAX_W, chips.reduce((a, b) => a + b, 0) + 22);
  const widest = Math.max(n.label.length * CHAR_W + 24, head + 22, row);
  const w = Math.min(MAX_W, Math.max(MIN_W, Math.round(widest)));
  let rows = 1;
  let used = 0;
  for (const cw of chips) {
    if (used + cw > w - 22 && used > 0) {
      rows += 1;
      used = 0;
    }
    used += cw;
  }
  return { w, h: 70 + 30 * Math.min(rows, 3) };
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

/** Tries of ELK's layered layout with different random seeds; the one with the fewest crossings wins. */
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** Whether two orthogonal segments cross in the open (touching at a shared port is not a crossing). */
function crosses(a0: Pt, a1: Pt, b0: Pt, b1: Pt): boolean {
  const aH = Math.abs(a0[1] - a1[1]) < 0.5;
  const bH = Math.abs(b0[1] - b1[1]) < 0.5;
  if (aH === bH) return false;
  const [h0, h1, v0, v1] = aH ? [a0, a1, b0, b1] : [b0, b1, a0, a1];
  const x = v0[0];
  const y = h0[1];
  const eps = 1;
  return (
    x > Math.min(h0[0], h1[0]) + eps &&
    x < Math.max(h0[0], h1[0]) - eps &&
    y > Math.min(v0[1], v1[1]) + eps &&
    y < Math.max(v0[1], v1[1]) - eps
  );
}

/** Lines that cross each other, so a layout with fewer is a calmer picture. */
export function countCrossings(routes: ReadonlyMap<string, readonly Pt[]>): number {
  const all = [...routes.values()];
  let n = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i] as readonly Pt[];
      const b = all[j] as readonly Pt[];
      for (let p = 1; p < a.length; p++) {
        for (let q = 1; q < b.length; q++) {
          if (crosses(a[p - 1] as Pt, a[p] as Pt, b[q - 1] as Pt, b[q] as Pt)) n += 1;
        }
      }
    }
  }
  return n;
}

function bends(routes: ReadonlyMap<string, readonly Pt[]>): number {
  let n = 0;
  for (const r of routes.values()) n += Math.max(0, r.length - 2);
  return n;
}

async function runElk(g: Graph, seed: number): Promise<OverviewLayout> {
  const sizes = new Map(g.connected.map((n) => [n.id, boxSize(n)]));
  const ids = new Set(g.connected.map((n) => n.id));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.partitioning.activate": "true",
      "elk.randomSeed": String(seed),
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.layered.spacing.edgeNodeBetweenLayers": "26",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
      "elk.spacing.nodeNode": "34",
      "elk.spacing.edgeEdge": "14",
      "elk.spacing.edgeNode": "20",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
      "elk.layered.thoroughness": "30",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
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
  return {
    w: Math.ceil(right),
    h: Math.ceil(bottom),
    nodes,
    routes,
    tags,
    crossings: countCrossings(routes),
  };
}

/**
 * The Overview: left to right in the four lanes, ELK's layered layout with orthogonal routing, each box held
 * in its lane by a partition so a lane never lands left of the one before it. It runs with a few seeds and
 * keeps the picture with the fewest crossings, then the fewest bends and the smallest size.
 */
export async function layoutOverview(g: Graph): Promise<OverviewLayout> {
  const key = overviewKey(g);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let best: { layout: OverviewLayout; score: number } | undefined;
  for (const seed of SEEDS) {
    const layout = await runElk(g, seed);
    const score =
      countCrossings(layout.routes) * 1000 + bends(layout.routes) * 4 + (layout.w + layout.h) / 50;
    if (best === undefined || score < best.score) best = { layout, score };
    if (best.score < 100 && seed >= 3) break;
  }
  const out = (best as { layout: OverviewLayout }).layout;
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
export function badgePos(pts: readonly Pt[], back = 24): Pt {
  const { x, y, px, py, l } = ends(pts);
  const d = Math.min(back, l / 2);
  return [x - ((x - px) / l) * d, y - ((y - py) / l) * d];
}

/** Where each numbered step sits: near its arrow head, moved back along the line when another number is already there. */
export function badgePositions(order: readonly (readonly Pt[] | undefined)[]): (Pt | undefined)[] {
  const placed: Pt[] = [];
  return order.map((pts) => {
    if (pts === undefined) return undefined;
    let pos = badgePos(pts);
    for (const back of [24, 48, 72, 96]) {
      const c = badgePos(pts, back);
      pos = c;
      if (!placed.some((q) => Math.hypot(q[0] - c[0], q[1] - c[1]) < 22)) break;
    }
    placed.push(pos);
    return pos;
  });
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
// Inside a project

export interface InsideLayout {
  w: number;
  h: number;
  /** Frames of the services, with their title. */
  frames: { svc: string; y: number; h: number }[];
  entries: Map<string, Place>;
  fns: Map<string, Place>;
  data: Map<string, Place>;
  /** Lines by the key the story uses: `i:<entry>`, `c:<a>><b>`, `d:<fn>><data>`. */
  routes: Map<string, Pt[]>;
  /** Where a step's number sits, by line key. */
  badge: Map<string, Pt>;
  frameX: number;
  frameW: number;
  /** Where the "Show more entry points" button sits (top of it). */
  moreAt: number;
}

const IN_EW = 184;
const IN_EH = 66;
const IN_FW = 164;
const IN_FRW = 204;
const IN_DW = 142;
const IN_DH = 54;

/**
 * Entry points on the left, the functions in frames by the service that runs them in the middle, data and
 * outside services on the right. "More" makes each function taller (it says what it does) and spaces them.
 */
export function layoutInside(spec: InsideSpec, more: boolean): InsideLayout {
  const FH = more ? 62 : 46;
  const P = more ? 78 : 56;
  const frameX = IN_EW + 34;
  const fx = frameX + 20;
  const dataX = frameX + IN_FRW + 38;
  const cx = fx + IN_FW / 2;
  const fns = new Map<string, Place>();
  const frames: InsideLayout["frames"] = [];
  let y = 22;
  for (const svc of spec.services) {
    const members = spec.fns.filter((f) => f.service === svc);
    const top = y;
    y += 30;
    members.forEach((f, i) => {
      fns.set(f.id, { x: fx, y, w: IN_FW, h: FH });
      y += i < members.length - 1 ? P : FH;
    });
    const bottom = y + 12;
    frames.push({ svc, y: top, h: bottom - top });
    y = bottom + 14;
  }
  const cyOf = (p: Place) => p.y + p.h / 2;

  // Data hangs next to the first function that uses it, spread when one function uses several, then pushed
  // down so two never overlap.
  const firstUser = new Map<string, string>();
  for (const u of spec.uses) if (!firstUser.has(u.data) && fns.has(u.fn)) firstUser.set(u.data, u.fn);
  const perFn = new Map<string, string[]>();
  for (const d of spec.data) {
    const fn = firstUser.get(d.id);
    if (fn !== undefined) perFn.set(fn, [...(perFn.get(fn) ?? []), d.id]);
  }
  const wanted: { id: string; cy: number }[] = [];
  for (const [fn, ids] of perFn) {
    const base = cyOf(fns.get(fn) as Place);
    for (const [k, id] of ids.entries())
      wanted.push({ id, cy: base + (k - (ids.length - 1) / 2) * (IN_DH + 6) });
  }
  wanted.sort((a, b) => a.cy - b.cy);
  const data = new Map<string, Place>();
  let floor = 12;
  for (const w of wanted) {
    const top = Math.max(w.cy - IN_DH / 2, floor);
    data.set(w.id, { x: dataX, y: top, w: IN_DW, h: IN_DH });
    floor = top + IN_DH + 6;
  }

  // Entry points stack on the left in the order given; the picked one's story is what the rest draws.
  const entries = new Map<string, Place>();
  let entryFloor = 12;
  for (const e of spec.entries) {
    entries.set(e.id, { x: 0, y: entryFloor, w: IN_EW, h: IN_EH });
    entryFloor += IN_EH + 8;
  }
  const ordered = spec.entries.filter((e) => fns.has(e.fn));

  const routes = new Map<string, Pt[]>();
  const badge = new Map<string, Pt>();
  for (const e of ordered) {
    const from = entries.get(e.id) as Place;
    const to = fns.get(e.fn) as Place;
    const ey = cyOf(from);
    const ty = cyOf(to);
    const mid = IN_EW + 18;
    routes.set(
      `i:${e.id}`,
      Math.abs(ey - ty) < 1
        ? [
            [IN_EW, ey],
            [fx, ty],
          ]
        : [
            [IN_EW, ey],
            [mid, ey],
            [mid, ty],
            [fx, ty],
          ],
    );
  }
  let lane = 0;
  for (const c of spec.calls) {
    const a = fns.get(c.from);
    const b = fns.get(c.to);
    if (a === undefined || b === undefined) continue;
    const adjacent = Math.abs(a.y - b.y) <= P + 1 && a.y !== b.y && Math.abs(cyOf(a) - cyOf(b)) <= P + 1;
    if (adjacent) {
      routes.set(
        `c:${c.from}>${c.to}`,
        a.y < b.y
          ? [
              [cx, a.y + a.h],
              [cx, b.y],
            ]
          : [
              [cx, a.y],
              [cx, b.y + b.h],
            ],
      );
    } else {
      const gx = fx - 8 - 6 * (lane % 3);
      lane += 1;
      routes.set(`c:${c.from}>${c.to}`, [
        [fx, cyOf(a)],
        [gx, cyOf(a)],
        [gx, cyOf(b)],
        [fx, cyOf(b)],
      ]);
    }
  }
  for (const u of spec.uses) {
    const a = fns.get(u.fn);
    const d = data.get(u.data);
    if (a === undefined || d === undefined) continue;
    const py = cyOf(a);
    const qy = cyOf(d);
    routes.set(
      `d:${u.fn}>${u.data}`,
      Math.abs(py - qy) < 1
        ? [
            [fx + IN_FW, py],
            [dataX, qy],
          ]
        : [
            [fx + IN_FW, py],
            [dataX - 26, py],
            [dataX - 26, qy],
            [dataX, qy],
          ],
    );
  }
  for (const [key, pts] of routes) {
    if (key.startsWith("c:")) {
      const p0 = pts[0] as Pt;
      const p1 = pts[1] as Pt;
      badge.set(key, pts.length === 2 ? [p0[0] + 22, (p0[1] + p1[1]) / 2] : badgePos(pts));
    } else badge.set(key, badgePos(pts));
  }
  const bottoms = [...fns.values(), ...data.values(), ...entries.values()].map((p) => p.y + p.h);
  bottoms.push(entryFloor + 36);
  return {
    w: dataX + IN_DW,
    h: Math.max(60, y - 4, ...bottoms),
    frames,
    entries,
    fns,
    data,
    routes,
    badge,
    frameX,
    frameW: IN_FRW,
    moreAt: entryFloor,
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
