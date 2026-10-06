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

/** The route's parts against the call's, same count: a parameter takes any part, a literal takes the same literal. A call's own parameter fits a route parameter only. */
function fits(route: readonly Segment[], call: readonly Segment[]): boolean {
  return (
    route.length === call.length &&
    route.every((r, i) => {
      const c = call[i];
      if (c === undefined) return false;
      return r.param || (!c.param && c.text === r.text);
    })
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
  const usable = routes.filter((r) => methodFits(r.method, call.method));
  let hits = usable.filter((r) => fits(r.segs, call.segs));
  if (hits.length === 0) hits = usable.filter((r) => fitsUnderMount(r.segs, call.segs));
  if (hits.length === 0) return { kind: "none" };
  const rank = (r: RouteRef): [number, number] => [
    r.method === call.method ? 0 : 1,
    r.segs.filter((s) => s.param).length,
  ];
  const [m0, p0] = rank(
    hits.toSorted((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1])[0] as RouteRef,
  );
  const best = hits.filter((r) => rank(r)[0] === m0 && rank(r)[1] === p0);
  const shapes = new Set(best.map((r) => `${r.project}|${r.method}|${signature(r.segs)}`));
  const first = best[0] as RouteRef;
  if (shapes.size === 1) return { kind: "one", route: first };
  return { kind: "ambiguous", projects: [...new Set(best.map((r) => r.project))].toSorted() };
}
