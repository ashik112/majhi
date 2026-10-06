import type { DiagramTone, MapEdge, MapNode, MapNodeKind, MapTask, MapView } from "@majhi/shared";
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
