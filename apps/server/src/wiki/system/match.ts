import type { WikiFactOf } from "@majhi/shared";

/**
 * Matching a client call to a route of another project, by method and path. Exact only: a call links when one route
 * fits it and no other route of a different project, method or shape fits it as well. Pure.
 */

/** A path part: a literal name, or a parameter (`{id}`, `:id`, `<id>`, `[id]`, `*`, or `{}` in a call, where the code fills it in). */
export type Segment = { param: true } | { param: false; text: string };

function isParam(part: string): boolean {
  return (
    part === "{}" ||
    part === "*" ||
    part === "**" ||
    (part.startsWith("{") && part.endsWith("}")) ||
    part.startsWith(":") ||
    (part.startsWith("<") && part.endsWith(">")) ||
    (part.startsWith("[") && part.endsWith("]"))
  );
}

/** The parts of a path, without empty parts, so a trailing slash does not matter. A part that is a whole parameter is one; any other is a literal. */
export function segmentsOf(path: string): Segment[] {
  return path
    .split("/")
    .filter((p) => p !== "")
    .map((p): Segment => (isParam(p) ? { param: true } : { param: false, text: p }));
}

const signature = (segs: readonly Segment[]): string => segs.map((s) => (s.param ? "{}" : s.text)).join("/");

export interface RouteRef {
  project: string;
  fact: WikiFactOf<"entry">;
  method: string;
  segs: readonly Segment[];
}

export interface CallShape {
  method: string;
  segs: readonly Segment[];
}

/** Literal parts that must agree, at least, for a route with parameters to count as the same route: one name in common is a coincidence. */
const MIN_LITERALS = 2;

/**
 * The route's parts against the call's, same count: a parameter takes any part, a literal takes the same literal. A
 * call's own parameter fits a route parameter only. A route that is all literals must equal the call; a route with
 * parameters needs at least `MIN_LITERALS` literal parts that agree, so `/:org/:project/files/*` is not every
 * four-part path with `files` in it.
 */
function fits(route: readonly Segment[], call: readonly Segment[]): boolean {
  if (route.length !== call.length) return false;
  let literals = 0;
  for (const [i, r] of route.entries()) {
    const c = call[i];
    if (c === undefined) return false;
    if (r.param) continue;
    if (c.param || c.text !== r.text) return false;
    literals += 1;
  }
  return (
    literals >= Math.min(MIN_LITERALS, route.length) &&
    (literals === route.length || literals >= MIN_LITERALS)
  );
}

/**
 * A route that is shorter than the call by leading parts only: a router mounted under a prefix the route facts
 * never saw (the facts pass keeps the shortest path of a route mounted twice). Needs two parts, so `/health` alone
 * never matches every `.../health`.
 */
function fitsUnderMount(route: readonly Segment[], call: readonly Segment[]): boolean {
  return (
    route.length >= 2 && call.length > route.length && fits(route, call.slice(call.length - route.length))
  );
}

const methodFits = (route: string, call: string) => route === "ANY" || call === "ANY" || route === call;

export type Match =
  | { kind: "one"; route: RouteRef }
  | { kind: "none" }
  | { kind: "ambiguous"; projects: string[] };

/**
 * The route a call goes to among `routes`. The same path first; only when none has it, the routes it reaches under a
 * mount prefix. Of several, the one that names its method and has the fewest parameters wins (static before dynamic,
 * as a router does). Routes left tied that are not one route (another project, method or shape) make it ambiguous.
 */
export function matchRoute(call: CallShape, routes: readonly RouteRef[]): Match {
  // One pass, no copy of the routes: the same path first, and the mount tier only when no route has it.
  const same: RouteRef[] = [];
  const mounted: RouteRef[] = [];
  for (const r of routes) {
    if (!methodFits(r.method, call.method)) continue;
    if (fits(r.segs, call.segs)) same.push(r);
    else if (same.length === 0 && fitsUnderMount(r.segs, call.segs)) mounted.push(r);
  }
  const hits = same.length > 0 ? same : mounted;
  if (hits.length === 0) return { kind: "none" };
  const rank = (r: RouteRef): [number, number] => [
    r.method === call.method ? 0 : 1,
    r.segs.filter((s) => s.param).length,
  ];
  const ranked = hits.map((r) => ({ r, k: rank(r) })).toSorted((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1]);
  const [m0, p0] = (ranked[0] as (typeof ranked)[number]).k;
  const best = ranked.filter((x) => x.k[0] === m0 && x.k[1] === p0).map((x) => x.r);
  const shapes = new Set(best.map((r) => `${r.project}|${r.method}|${signature(r.segs)}`));
  if (shapes.size === 1) return { kind: "one", route: best[0] as RouteRef };
  return { kind: "ambiguous", projects: [...new Set(best.map((r) => r.project))].toSorted() };
}
