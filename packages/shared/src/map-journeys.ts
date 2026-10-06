import { DIAGRAM_LIMITS, type DiagramSpec, DiagramSpecSchema } from "./diagram.ts";
import { JOURNEY_LIMITS, type Journey, type JourneyView } from "./journeys.ts";
import type { MapEdge, ProjectMap } from "./map.ts";

/** Examples shown at once, so the list stays short. */
const EXAMPLES_MAX = 5;

/** A line nobody has checked and that only the model proposed. */
const unchecked = (e: MapEdge): boolean => e.confidence === "ambiguous";

/**
 * A stored journey as it is shown. A step whose line is gone from the map (the owner removed it, or an
 * update no longer finds it) is kept and marked "needs a check": a journey never loses a step by itself.
 */
export function resolveJourney(map: ProjectMap, journey: Journey): JourneyView {
  const edges = new Map(map.edges.map((e) => [e.id, e]));
  return {
    id: journey.id,
    name: journey.name,
    status: "kept",
    steps: journey.steps.map((s) => {
      const edge = s.edge === undefined ? undefined : edges.get(s.edge);
      return {
        from: s.from,
        to: s.to,
        label: s.label,
        ...(edge === undefined ? {} : { edge: edge.id }),
        check: edge === undefined || unchecked(edge),
      };
    }),
  };
}

/**
 * Examples: for each app (a project nothing else calls) and each line it starts, the chain of lines that
 * follows from one box to the next, never back to a box already on the way. Only lines a file or the
 * owner vouches for count. Each is a guess at what happens; the owner keeps the ones that are right.
 */
export function proposeJourneys(map: ProjectMap, kept: readonly JourneyView[]): JourneyView[] {
  const lines = map.edges
    .filter((e) => e.type !== "together" && !unchecked(e))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const label = new Map(map.nodes.map((n) => [n.id, n.label]));
  const roleOf = (id: string) =>
    map.roles.find((r) => r.project === id)?.role ?? map.nodes.find((n) => n.id === id)?.role;
  const called = new Set(lines.map((e) => e.to));
  const entries = map.nodes
    .filter(
      (n) =>
        n.project !== undefined &&
        lines.some((e) => e.from === n.id) &&
        (roleOf(n.id) === "app" || !called.has(n.id)),
    )
    .map((n) => n.id)
    .toSorted();
  const followed = new Set(kept.map((j) => j.steps.map((s) => s.edge ?? "").join("|")));
  const found: JourneyView[] = [];
  for (const entry of entries) {
    for (const first of lines.filter((e) => e.from === entry)) {
      const chain = [first];
      const seen = new Set([entry, first.to]);
      for (;;) {
        const last = chain.at(-1) as MapEdge;
        const next = lines.find((e) => e.from === last.to && !seen.has(e.to));
        if (next === undefined || chain.length >= JOURNEY_LIMITS.steps) break;
        chain.push(next);
        seen.add(next.to);
      }
      if (chain.length < 2) continue;
      const key = chain.map((e) => e.id).join("|");
      if (followed.has(key) || found.some((j) => j.id === `example:${key}`)) continue;
      const end = chain.at(-1) as MapEdge;
      found.push({
        id: `example:${key}`,
        name: `${label.get(entry) ?? entry} to ${label.get(end.to) ?? end.to}`.slice(0, JOURNEY_LIMITS.name),
        status: "example",
        steps: chain.map((e) => ({
          from: e.from,
          to: e.to,
          label: e.label.slice(0, JOURNEY_LIMITS.label),
          edge: e.id,
          check: false,
        })),
      });
    }
  }
  return found.slice(0, EXAMPLES_MAX);
}

/** Every journey of a workspace as shown: the owner's, then the examples. */
export function journeysOf(map: ProjectMap, stored: readonly Journey[]): JourneyView[] {
  const kept = stored.map((j) => resolveJourney(map, j));
  return [...kept, ...proposeJourneys(map, kept)];
}

/**
 * A journey as a sequence diagram: one lane per box in the order the journey first reaches it, one
 * message per step in order, numbered. A step that needs a check is dashed and marked.
 */
export function journeySpec(
  map: ProjectMap,
  journey: JourneyView,
): { spec: DiagramSpec } | { problem: string } {
  const label = new Map(map.nodes.map((n) => [n.id, n.label]));
  const type = new Map(map.edges.map((e) => [e.id, e.type]));
  const actors: string[] = [];
  for (const s of journey.steps) {
    for (const id of [s.from, s.to]) if (!actors.includes(id)) actors.push(id);
  }
  if (actors.length > DIAGRAM_LIMITS.actors) {
    return { problem: `The journey "${journey.name}" has more than ${DIAGRAM_LIMITS.actors} boxes to draw.` };
  }
  const parsed = DiagramSpecSchema.safeParse({
    title: journey.name.slice(0, 80),
    layout: "sequence",
    actors,
    nodes: actors.map((id) => ({ id, label: (label.get(id) ?? id).slice(0, DIAGRAM_LIMITS.label) })),
    edges: journey.steps.map((s, i) => {
      const t = s.edge === undefined ? undefined : type.get(s.edge);
      return {
        from: s.from,
        to: s.to,
        label: `${i + 1}. ${s.label}${s.check ? " (needs a check)" : ""}`.slice(0, DIAGRAM_LIMITS.label),
        type: t === "http" || t === "queue" || t === "data" || t === "lib" ? t : "step",
        ...(s.check ? { style: "dashed" as const, tone: "warn" as const } : {}),
      };
    }),
  });
  return parsed.success ? { spec: parsed.data } : { problem: `Could not draw "${journey.name}".` };
}
