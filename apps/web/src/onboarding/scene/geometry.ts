/**
 * The river scene's geometry, in the painting's own pixels (a 1024 by 1536 rickshaw-art panel;
 * public/onboarding/river-day.webp and river-night.webp share it). The river's middle line was
 * traced from the painting; it rises from the bottom edge and winds up to the ghat under the sun or
 * moon. The stops sit along it from near (Welcome) to far (Arrive, at the ghat). Everything is
 * worked out once at module load: plain numbers, no DOM.
 */

export const VIEW_W = 1024;
export const VIEW_H = 1536;
/** Where the river meets the ghat steps. */
export const GHAT_Y = 430;
/** The nearest stop. */
const NEAR_Y = 1390;

export interface Point {
  x: number;
  y: number;
}

/** The river's middle line, bottom to top, traced from the painting. */
const SPINE: readonly Point[] = [
  { x: 492, y: 1620 },
  { x: 505, y: 1440 },
  { x: 498, y: 1320 },
  { x: 482, y: 1200 },
  { x: 462, y: 1100 },
  { x: 418, y: 1020 },
  { x: 462, y: 962 },
  { x: 560, y: 905 },
  { x: 604, y: 860 },
  { x: 562, y: 812 },
  { x: 472, y: 776 },
  { x: 410, y: 726 },
  { x: 424, y: 680 },
  { x: 500, y: 640 },
  { x: 588, y: 596 },
  { x: 560, y: 550 },
  { x: 472, y: 510 },
  { x: 456, y: 478 },
  { x: 498, y: 446 },
  { x: 512, y: GHAT_Y },
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

const samples = smooth(SPINE, 30);
const lengths: number[] = [0];
for (let i = 1; i < samples.length; i += 1) {
  const a = at(samples, i - 1);
  const b = at(samples, i);
  lengths.push(at(lengths, i - 1) + Math.hypot(b.x - a.x, b.y - a.y));
}
/** The river's length along its middle, bottom edge to the ghat. */
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

/** How near the water at `y` is: 0 at the ghat, 1 at the nearest stop. */
function nearness(y: number): number {
  return Math.max(0, Math.min(1, (y - GHAT_Y) / (NEAR_Y - GHAT_Y)));
}

/** The river's width at `y` in the painting, roughly: narrow at the ghat, wide at the bottom. */
export function widthAt(y: number): number {
  return 190 + 330 * nearness(y);
}

/** How big a thing on the water at `y` is drawn: the painting's gentle perspective. */
export function scaleAt(y: number): number {
  return 0.46 + 0.54 * nearness(y) ** 0.9;
}

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

/** The signboard's width at full size, in painting pixels; it shrinks a little with distance. */
const SIGN_W = 210;
/** The signboard art's height over width (public/onboarding/sign.webp): the plaque alone. */
export const SIGN_RATIO = 174 / 320;
/** The two columns the signs stand in, one on each bank, clear of the river and the boat. */
const SIGN_X = { left: 205, right: 819 } as const;

export interface StopPlace {
  /** Where the boat waits, on the middle line. */
  s: number;
  boat: Point;
  /** Where the signboard's bottom edge meets the bank. */
  sign: Point;
  /** The signboard's width in painting pixels. */
  signW: number;
  /** Which bank the sign stands on. */
  side: -1 | 1;
  scale: number;
}

/**
 * The stops, near to far, evenly spaced up the painting. The signboards alternate banks, starting
 * on the right, in two fixed columns: the boat keeps the middle of the river to itself, and
 * neighbouring signs never stack.
 */
export function stopPlaces(count: number): StopPlace[] {
  const places: StopPlace[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : i / (count - 1);
    const y = NEAR_Y + (GHAT_Y + 50 - NEAR_Y) * t;
    const s = lengthAtY(y);
    const boat = pointAt(s);
    const scale = scaleAt(boat.y);
    const signW = SIGN_W * (0.8 + 0.2 * scale);
    const side: -1 | 1 = i % 2 === 0 ? 1 : -1;
    const x = side < 0 ? SIGN_X.left : SIGN_X.right;
    places.push({ s, boat, sign: { x, y: boat.y + 20 * scale }, signW, side, scale });
  }
  return places;
}
