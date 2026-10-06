import {
  type Diagram,
  type DiagramNode,
  type DiagramTone,
  endpointId,
  type MapEdge,
  type MapEndpoint,
  type MapNode,
  type MapNodeKind,
  type MapRole,
  type MapTask,
  type MapView,
} from "@majhi/shared";
import { z } from "zod";
import type { LampState } from "@/components/ui/lamp";

/** The four ways to look at one map. The data is the same; a view dims what it is not about. */
export const MAP_VIEWS = [
  { id: "all", label: "All" },
  { id: "flow", label: "Data flow" },
  { id: "deploy", label: "Deployment" },
  { id: "changed", label: "Recent changes" },
] as const;
export type MapViewId = (typeof MAP_VIEWS)[number]["id"];

export const KIND_LABEL: Record<MapNodeKind, string> = {
  project: "Project",
  library: "Library",
  database: "Database",
  queue: "Queue",
  cache: "Cache",
  outside: "Outside",
  connection: "Connection",
};

/** The tone of a kind's tag on a box. Plain message colors; none is a lamp. */
export const KIND_TONE: Record<MapNodeKind, DiagramTone> = {
  project: "accent",
  library: "neutral",
  database: "good",
  queue: "accent",
  cache: "accent",
  outside: "neutral",
  connection: "neutral",
};

const NEEDS_YOU = new Set(["review", "paused", "mr"]);

/** What the open tasks of a project say about it: waiting for the owner, working, or nothing. */
export function lampOf(tasks: readonly MapTask[]): { state: LampState; word: string } | undefined {
  if (tasks.some((t) => NEEDS_YOU.has(t.status))) return { state: "needs", word: "needs you" };
  if (tasks.some((t) => t.status === "running")) return { state: "working", word: "working" };
  return undefined;
}

/** Whether an edge belongs in a view. The rest is dimmed, not hidden: the map keeps its shape. */
export function edgeInView(view: MapViewId, edge: MapEdge, changed: ReadonlySet<string>): boolean {
  switch (view) {
    case "all":
    case "deploy":
      return true;
    case "flow":
      return edge.type === "http" || edge.type === "queue";
    case "changed":
      return changed.has(edge.from) || changed.has(edge.to);
  }
}

/** Whether a box belongs in a view: it is on a line that does, or (changed) it is a changed project. */
export function nodeInView(
  view: MapViewId,
  node: MapNode,
  edges: readonly MapEdge[],
  changed: ReadonlySet<string>,
): boolean {
  if (view === "all" || view === "deploy") return true;
  if (view === "changed" && changed.has(node.id)) return true;
  return edges.some((e) => (e.from === node.id || e.to === node.id) && edgeInView(view, e, changed));
}

/** "just now", "5 min ago", "3 h ago", "3 days ago". */
export function agoWords(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function mergesWords(n: number): string {
  return `${n} ${n === 1 ? "merge" : "merges"} since`;
}

/** The estimate on the button: "~$0.30", "~$0.02" and under a cent "<$0.01". */
export function usdWords(usd: number): string {
  if (usd < 0.005) return "<$0.01";
  return `~$${usd.toFixed(2)}`;
}

/** The open tasks of a box, for its panel: the tasks that name its project. */
export function tasksOf(view: MapView, node: MapNode): MapTask[] {
  return node.project === undefined
    ? []
    : view.tasks.filter((t) => t.projects.includes(node.project as string));
}

// ---------------------------------------------------------------------------
// What the page draws

const ROLE_RANK: Record<MapRole, number> = { app: 0, service: 1, worker: 2 };
/** Libraries and shared datastores stand in the last column. */
const DATA_RANK = 3;

/** A line nobody has checked and that only the model proposed: kept out of the picture until the owner reviews it. */
export function needsReview(edge: MapEdge): boolean {
  return edge.state === "new" && edge.confidence === "ambiguous";
}

/** The role a project is drawn with: the owner's choice, else what its dependencies show. */
export function roleOf(view: MapView, node: MapNode): MapRole {
  return view.map.roles.find((r) => r.project === node.id)?.role ?? node.role ?? "service";
}

/** Whether an address has an owner: a compose file proves it, or the owner answered. */
function answered(view: MapView, e: MapEndpoint): boolean {
  if (e.known !== undefined) return true;
  const id = endpointId(e.host, e.port, e.scope);
  return view.map.resolutions.some((r) => endpointId(r.host, r.port, r.scope) === id);
}

/** Addresses the projects call that nobody has said anything about, the most called first. */
export function unansweredAddresses(view: MapView): MapEndpoint[] {
  return view.map.endpoints
    .filter((e) => !answered(view, e))
    .toSorted((a, b) => b.refs.length - a.refs.length || a.id.localeCompare(b.id));
}

/** What a project card shows as "Uses": its outside services, and the addresses the owner called outside. */
export function usesOf(view: MapView, node: MapNode): string[] {
  const named = view.map.resolutions.filter((r) => r.to.kind === "outside");
  const hosts = view.map.endpoints
    .filter(
      (e) =>
        e.refs.some((r) => r.project === node.id) &&
        named.some((r) => endpointId(r.host, r.port, r.scope) === endpointId(e.host, e.port, e.scope)),
    )
    .map((e) => e.host);
  return [...new Set([...(node.uses ?? []), ...hosts])];
}

export interface MapPrefs {
  /** Projects the owner hid. */
  hidden: string[];
  hideAlone: boolean;
}

const NO_PREFS: MapPrefs = { hidden: [], hideAlone: false };
const PrefsSchema = z.object({ hidden: z.array(z.string()), hideAlone: z.boolean() });
const prefsKey = (org: string) => `majhi.map.show.${org}`;

export function readPrefs(org: string): MapPrefs {
  try {
    const raw = localStorage.getItem(prefsKey(org));
    if (raw === null) return NO_PREFS;
    const parsed = PrefsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : NO_PREFS;
  } catch {
    return NO_PREFS;
  }
}

export function writePrefs(org: string, prefs: MapPrefs): void {
  try {
    localStorage.setItem(prefsKey(org), JSON.stringify(prefs));
  } catch {
    // Storage blocked: the choice lasts until the page closes.
  }
}

export interface Shape {
  diagram: Diagram;
  /** Boxes that many others connect to. */
  hubs: ReadonlySet<string>;
  /** Projects with no line. */
  alone: number;
  /** Boxes drawn. */
  shownNodes: number;
}

/**
 * The Map page's diagram: the projects the owner shows, grouped into the systems their lines make (the
 * boxes that are linked, directly or through others), each system in columns by role. Boxes with no line
 * wait in a compact "Not connected" group. In the deployment view the groups are where things run.
 */
export function shapeMap(view: MapView, options: { viewId: MapViewId; prefs: MapPrefs }): Shape {
  const { viewId, prefs } = options;
  const hidden = new Set(prefs.hidden);
  const showTogether = viewId === "all" || viewId === "changed";
  const visible = view.map.nodes.filter((n) => !hidden.has(n.id));
  const ids = new Set(visible.map((n) => n.id));
  const edges = view.map.edges.filter(
    (e) => ids.has(e.from) && ids.has(e.to) && !needsReview(e) && (e.type !== "together" || showTogether),
  );
  const linked = edges.filter((e) => e.type !== "together");
  const degree = new Map<string, number>();
  for (const e of linked) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const deg = (id: string) => degree.get(id) ?? 0;
  // A shared datastore no shown project reaches is not drawn.
  const nodes = visible.filter((n) => n.project !== undefined || deg(n.id) > 0);
  const rankOf = (n: MapNode) => (n.kind === "project" ? ROLE_RANK[roleOf(view, n)] : DATA_RANK);
  const toDiagram = (n: MapNode, group: string): DiagramNode => ({
    id: n.id,
    label: n.label,
    ...(n.sub === undefined ? {} : { sub: n.sub }),
    kind: KIND_LABEL[n.kind],
    tone: KIND_TONE[n.kind],
    group,
    rank: rankOf(n),
  });

  if (viewId === "deploy") {
    const targets = [...new Set(nodes.map((n) => n.deploy ?? "not known"))];
    return {
      hubs: new Set(),
      alone: 0,
      shownNodes: nodes.length,
      diagram: {
        layout: "lanes",
        nodes: [
          ...targets.map((t): DiagramNode => ({ id: `deploy:${t}`, label: t })),
          ...nodes.map((n) => toDiagram(n, `deploy:${n.deploy ?? "not known"}`)),
        ],
        edges,
      },
    };
  }

  // Systems: boxes joined by lines, through any number of others.
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at) at = parent.get(at) ?? at;
    return at;
  };
  for (const e of linked) {
    if (parent.has(e.from) && parent.has(e.to)) parent.set(find(e.from), find(e.to));
  }
  const byRoot = new Map<string, MapNode[]>();
  for (const n of nodes) byRoot.set(find(n.id), [...(byRoot.get(find(n.id)) ?? []), n]);
  const all = [...byRoot.values()];
  const alone = all.filter((g) => g.length === 1 && deg(g[0]?.id ?? "") === 0);
  const systems = all
    .filter((g) => !alone.includes(g))
    .toSorted((a, b) => b.length - a.length || (a[0]?.id ?? "").localeCompare(b[0]?.id ?? ""));

  const hubs = new Set<string>();
  const frames: DiagramNode[] = [];
  const boxes: DiagramNode[] = [];
  systems.forEach((members, i) => {
    const best = members.toSorted((a, b) => deg(b.id) - deg(a.id) || a.id.localeCompare(b.id));
    const top = deg(best[0]?.id ?? "");
    for (const n of members) {
      if (deg(n.id) >= 3 || (members.length >= 4 && deg(n.id) === top && top >= 2)) hubs.add(n.id);
    }
    const id = `system:${i}`;
    frames.push({ id, label: `${best[0]?.label ?? "Group"} group` });
    for (const n of members) boxes.push(toDiagram(n, id));
  });
  const lonely = prefs.hideAlone ? [] : alone.flat();
  if (lonely.length > 0) {
    frames.push({ id: "alone", label: "Not connected", kind: "pack" });
    for (const n of lonely) boxes.push(toDiagram(n, "alone"));
  }
  return {
    hubs,
    alone: alone.length,
    shownNodes: boxes.length,
    diagram: { layout: "lanes", nodes: [...frames, ...boxes], edges },
  };
}
