import { DIAGRAM_LIMITS, type DiagramSpec, DiagramSpecSchema } from "./diagram.ts";
import { flowOf, type InsideSpec, type InsideStep, type InsideTrigger } from "./inside.ts";
import {
  JOURNEY_LIMITS,
  type Journey,
  type JourneyPartKind,
  type JourneyStepView,
  type JourneyView,
} from "./journeys.ts";
import type { MapEdge, ProjectMap } from "./map.ts";

/** Examples shown at once, so the list stays short. */
const EXAMPLES_MAX = 5;

/** A line nobody has checked and that only the model proposed. */
const unchecked = (e: MapEdge): boolean => e.confidence === "ambiguous";

/** What starts a journey that follows map lines: a job line starts a queue consumer, anything else a request. */
function triggerOfEdge(edge: MapEdge | undefined): InsideTrigger {
  return edge?.type === "queue" ? "QUEUE" : "HTTP";
}

/** The projects a journey between projects touches, in the order its steps reach them. */
function touchesOf(map: ProjectMap, steps: readonly { from: string; to: string }[]): string[] {
  const known = new Set(map.nodes.filter((n) => n.project !== undefined).map((n) => n.id));
  const out: string[] = [];
  for (const s of steps)
    for (const id of [s.from, s.to]) if (known.has(id) && !out.includes(id)) out.push(id);
  return out;
}

/**
 * A stored journey as it is shown. A step whose line is gone from the map (the owner removed it, or an
 * update no longer finds it) is kept and marked "needs a check": a journey never loses a step by itself.
 * A journey inside one project has no map lines: its steps stand on code and are never "needs a check".
 */
export function resolveJourney(map: ProjectMap, journey: Journey): JourneyView {
  const edges = new Map(map.edges.map((e) => [e.id, e]));
  const inner = journey.inner;
  const steps = journey.steps.map((s): JourneyStepView => {
    if (inner !== undefined) return { ...s, check: false };
    const edge = s.edge === undefined ? undefined : edges.get(s.edge);
    return {
      from: s.from,
      to: s.to,
      label: s.label,
      ...(edge === undefined ? {} : { edge: edge.id }),
      check: edge === undefined || unchecked(edge),
    };
  });
  const first = journey.steps[0]?.edge === undefined ? undefined : edges.get(journey.steps[0].edge);
  return {
    id: journey.id,
    name: journey.name,
    status: "kept",
    trigger: journey.trigger ?? (inner === undefined ? triggerOfEdge(first) : "HTTP"),
    start: inner?.project ?? journey.steps[0]?.from ?? "",
    touches: inner === undefined ? touchesOf(map, journey.steps) : [inner.project],
    ...(inner === undefined ? {} : { inner }),
    steps,
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
      const steps = chain.map((e) => ({
        from: e.from,
        to: e.to,
        label: e.label.slice(0, JOURNEY_LIMITS.label),
        edge: e.id,
        check: false,
      }));
      found.push({
        id: `example:${key}`,
        name: `${label.get(entry) ?? entry} to ${label.get(end.to) ?? end.to}`.slice(0, JOURNEY_LIMITS.name),
        status: "example",
        trigger: triggerOfEdge(first),
        start: entry,
        touches: touchesOf(map, steps),
        steps,
      });
    }
  }
  return found.slice(0, EXAMPLES_MAX);
}

const ENTRY_WORDS: Record<InsideTrigger, string> = {
  HTTP: "Request arrives",
  SOCKET: "Live connection opens",
  TOOL: "Tool is called",
  SCHEDULE: "Wake up",
  QUEUE: "Job arrives",
  COMMAND: "Run command",
};

/** A few words for one step of a story: "Build digest", "Save to notes". The full sentence is the proof text. */
function shortLabel(s: InsideStep, kind: InsideTrigger): string {
  if (s.kind === "entry") return ENTRY_WORDS[kind];
  if (s.kind === "call") return s.part;
  return `${s.part === "Database" ? "Use" : "Call"} ${s.to}`;
}

/** The part of a project's code a step end is: the entry that starts it, a function, a datastore or an outside service. */
function partKind(spec: InsideSpec, name: string, entryLabel: string): JourneyPartKind {
  if (name === entryLabel) return "entry";
  if (spec.fns.some((f) => f.id === name)) return "function";
  const d = spec.data.find((x) => x.name === name);
  return d?.kind === "out" ? "outside" : d?.kind === "db" ? "database" : "function";
}

/**
 * Examples inside one project: each entry point whose story has at least two steps is a journey that
 * never leaves the project. Kept ones (same project and entry) are not offered again.
 */
export function innerJourneys(spec: InsideSpec, kept: readonly JourneyView[]): JourneyView[] {
  const taken = new Set(kept.filter((j) => j.inner?.project === spec.project).map((j) => j.inner?.entry));
  const out: JourneyView[] = [];
  for (const entry of spec.entries) {
    if (taken.has(entry.id)) continue;
    const flow = flowOf(spec, entry).slice(0, JOURNEY_LIMITS.steps);
    if (flow.length < 2) continue;
    out.push({
      id: `example:inside:${spec.project}:${entry.id}`,
      name: entry.label.slice(0, JOURNEY_LIMITS.name),
      status: "example",
      trigger: entry.kind,
      start: spec.project,
      touches: [spec.project],
      inner: { project: spec.project, entry: entry.id },
      steps: flow.map((s) => ({
        from: s.from,
        to: s.to,
        label: shortLabel(s, entry.kind).slice(0, JOURNEY_LIMITS.label),
        fromKind: s.kind === "entry" ? "entry" : partKind(spec, s.from, entry.label),
        toKind: partKind(spec, s.to, entry.label),
        proof: { file: s.file, line: s.line, text: s.text },
        check: false,
      })),
    });
  }
  return out;
}

/** Every journey of a workspace as shown: the owner's, then the examples between projects, then those inside one. */
export function journeysOf(
  map: ProjectMap,
  stored: readonly Journey[],
  inside: readonly InsideSpec[] = [],
): JourneyView[] {
  const kept = stored.map((j) => resolveJourney(map, j));
  return [...kept, ...proposeJourneys(map, kept), ...inside.flatMap((s) => innerJourneys(s, kept))];
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
