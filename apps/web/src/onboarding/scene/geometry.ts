/**
 * The river scene's geometry, in the SVG's own units (a 480 by 900 view box). The river rises from
 * the bottom edge and winds up to the horizon; the stops sit along it from near (Welcome) to far
 * (Arrive, at the ghat). Everything is worked out once at module load: plain numbers, no DOM.
 */

export const VIEW_W = 480;
export const VIEW_H = 900;
/** Where the land meets the sky. */
export const HORIZON = 312;
/** The nearest and farthest stop. */
const NEAR_Y = 836;
const FAR_Y = 352;

export interface Point {
  x: number;
  y: number;
}

/** The river's middle line, bottom to top, through which a smooth curve is drawn. */
const SPINE: readonly Point[] = [
  { x: 238, y: 960 },
  { x: 292, y: 856 },
  { x: 214, y: 752 },
  { x: 284, y: 658 },
  { x: 222, y: 568 },
  { x: 270, y: 488 },
  { x: 232, y: 420 },
  { x: 262, y: 364 },
  { x: 250, y: 330 },
  { x: 256, y: HORIZON },
];

function at<T>(list: readonly T[], i: number): T {
  const item = list[Math.max(0, Math.min(list.length - 1, i))];
  if (item === undefined) throw new Error("empty list");
  return item;
}

/** A Catmull-Rom curve through `points`, sampled `per` times between each pair. */
function smooth(points: readonly Point[], per: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = at(points, i - 1);
    const p1 = at(points, i);
    const p2 = at(points, i + 1);
    const p3 = at(points, i + 2);
    for (let s = 0; s < per; s += 1) {
      const t = s / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(at(points, points.length - 1));
  return out;
}

const samples = smooth(SPINE, 40);
const lengths: number[] = [0];
for (let i = 1; i < samples.length; i += 1) {
  const a = at(samples, i - 1);
  const b = at(samples, i);
  lengths.push(at(lengths, i - 1) + Math.hypot(b.x - a.x, b.y - a.y));
}
/** The river's length along its middle, bottom edge to horizon. */
export const RIVER_LENGTH = at(lengths, lengths.length - 1);

/** The point `s` units along the middle line from the bottom edge. */
export function pointAt(s: number): Point {
  const d = Math.max(0, Math.min(RIVER_LENGTH, s));
  let lo = 0;
  let hi = lengths.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at(lengths, mid) < d) lo = mid;
    else hi = mid;
  }
  const a = at(samples, lo);
  const b = at(samples, hi);
  const span = at(lengths, hi) - at(lengths, lo);
  const t = span === 0 ? 0 : (d - at(lengths, lo)) / span;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** How far the land at `y` is: 0 at the horizon, 1 at the nearest stop and beyond. */
function nearness(y: number): number {
  return Math.max(0, Math.min(1.12, (y - HORIZON) / (NEAR_Y - HORIZON)));
}

/** The river's width at `y`: a thread at the horizon, wide at the bottom edge. */
export function widthAt(y: number): number {
  return 3 + 196 * nearness(y) ** 1.22;
}

/** How big a thing standing at `y` is drawn: perspective, so far things are small. */
export function scaleAt(y: number): number {
  return 0.3 + 0.7 * nearness(y) ** 0.95;
}

function fmt(n: number): string {
  return n.toFixed(1);
}

/** The water: the left bank up to the horizon, then the right bank back down. */
export const RIVER_PATH = (() => {
  const step = 4;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < samples.length; i += step) {
    const p = at(samples, i);
    const w = widthAt(p.y) / 2;
    left.push(`${fmt(p.x - w)} ${fmt(p.y)}`);
    right.push(`${fmt(p.x + w)} ${fmt(p.y)}`);
  }
  const top = at(samples, samples.length - 1);
  return `M${left.join(" L")} L${fmt(top.x)} ${fmt(top.y)} L${right.reverse().join(" L")} Z`;
})();

/** One bank's edge as an open line, for the thin bright rim where water meets land. */
function bankPath(side: -1 | 1): string {
  const points: string[] = [];
  for (let i = 0; i < samples.length; i += 4) {
    const p = at(samples, i);
    points.push(`${fmt(p.x + (side * widthAt(p.y)) / 2)} ${fmt(p.y)}`);
  }
  return `M${points.join(" L")}`;
}
export const LEFT_BANK = bankPath(-1);
export const RIGHT_BANK = bankPath(1);

/** The arc length whose point is nearest to height `y`. */
function lengthAtY(y: number): number {
  let best = 0;
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples.length; i += 1) {
    const d = Math.abs(at(samples, i).y - y);
    if (d < gap) {
      gap = d;
      best = i;
    }
  }
  return at(lengths, best);
}

export interface StopPlace {
  /** Where the boat waits, on the middle line. */
  s: number;
  boat: Point;
  /** The lantern's foot on the bank. */
  lantern: Point;
  /** Which bank the lantern and label are on. */
  side: -1 | 1;
  scale: number;
}

/**
 * The stops, near to far. Gaps shrink toward the horizon, as they would in perspective. Each
 * lantern stands on the bank with more land beside it, so its label has room.
 */
export function stopPlaces(count: number): StopPlace[] {
  const places: StopPlace[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : i / (count - 1);
    const y = FAR_Y + (NEAR_Y - FAR_Y) * (1 - t) ** 1.18;
    const s = lengthAtY(y);
    const boat = pointAt(s);
    const side: -1 | 1 = boat.x < VIEW_W / 2 ? 1 : -1;
    const scale = scaleAt(boat.y);
    const reach = widthAt(boat.y) / 2 + 10 + 16 * scale;
    places.push({
      s,
      boat,
      lantern: { x: boat.x + side * reach, y: boat.y - 4 * scale },
      side,
      scale,
    });
  }
  return places;
}

/** A small seeded random source, so the water lines and stars land in the same places every load. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FlowLine {
  x: number;
  y: number;
  length: number;
  width: number;
  delay: number;
  duration: number;
  /** How far it drifts toward the viewer in one pass. */
  drift: number;
}

/** Short strokes on the water that drift downstream and fade, so the river reads as flowing. */
export const FLOW_LINES: readonly FlowLine[] = (() => {
  const rand = seeded(7);
  const lines: FlowLine[] = [];
  for (let i = 0; i < 26; i += 1) {
    const s = RIVER_LENGTH * (0.04 + 0.86 * rand() ** 1.5);
    const p = pointAt(s);
    const w = widthAt(p.y);
    const k = scaleAt(p.y);
    lines.push({
      x: p.x + (rand() - 0.5) * w * 0.66,
      y: p.y,
      length: w * (0.1 + rand() * 0.16),
      width: 0.6 + 1.1 * k,
      delay: -rand() * 9,
      duration: 6 + rand() * 4,
      drift: 4 + 12 * k,
    });
  }
  return lines;
})();

export interface Star {
  x: number;
  y: number;
  r: number;
  delay: number;
  twinkle: boolean;
}

export const STARS: readonly Star[] = (() => {
  const rand = seeded(23);
  const stars: Star[] = [];
  for (let i = 0; i < 34; i += 1) {
    stars.push({
      x: rand() * VIEW_W,
      y: 40 + rand() ** 1.4 * (HORIZON - 120),
      r: 0.5 + rand() * 0.9,
      delay: -rand() * 6,
      twinkle: rand() < 0.4,
    });
  }
  return stars;
})();
