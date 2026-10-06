import {
  endpointId,
  type MapEdge,
  type MapEndpoint,
  type MapEvidence,
  type MapNode,
  type MapRole,
  type MapTask,
  type MapView,
} from "@majhi/shared";

/** The look of a box's state: its lamp class and the words beside it. */
export type NodeLamp = "idle" | "working" | "needs";

/** Four lanes, left to right. Shared datastores and queues stand in the third, libraries and outside services in the second. */
export const LANES = ["Apps", "Services", "Queue", "Workers"] as const;

/** What a line is drawn as: a call, a job through a queue, or something embedded or run together. */
export type LineKind = "calls" | "jobs" | "embeds";
export const LINE_KIND_LABEL: Record<LineKind, string> = { calls: "Call", jobs: "Job", embeds: "Embed" };

/** How sure a line is, in the words of the three tiers. */
export type Tier = "code" | "answer" | "check";
export const TIER_LABEL: Record<Tier, { text: string; tone: "green" | "blue" | "caution" }> = {
  code: { text: "Found in code", tone: "green" },
  answer: { text: "From your answer", tone: "blue" },
  check: { text: "Needs a check", tone: "caution" },
};
export const TIER_WHY: Record<Tier, string> = {
  code: "majhi read this call in the code.",
  answer: "You told the captain about this link. No call found in code yet.",
  check: "The code points here but majhi is not sure. Confirm it or say it is not a link.",
};

/** Names of datastores the config pass puts in a project's stack: shown as "Stores data in". */
const STORES: ReadonlySet<string> = new Set([
  "Postgres",
  "MySQL",
  "MongoDB",
  "Redis",
  "RabbitMQ",
  "Kafka",
  "NATS",
  "Memcached",
  "Elasticsearch",
  "ClickHouse",
  "SQLite",
  "S3",
]);

export interface PNode {
  id: string;
  label: string;
  /** The project this box is, when it is one. */
  project: string | undefined;
  /** What the badge says: App, Service, Queue, Worker, or a shared box's kind. */
  roleLabel: string;
  /** The badge's class. */
  roleClass: "app" | "service" | "queue" | "worker" | "";
  lane: 0 | 1 | 2 | 3;
  stack: string[];
  stores: string[];
  outside: string[];
  desc: string;
  deploy: string | undefined;
  /** Where its checkout is, with the home folder written `~`. */
  path: string | undefined;
  lamp: NodeLamp;
  /** "1 agent working", "needs you", "to check", "idle". */
  lampWord: string;
  tasks: MapTask[];
  ins: number;
  outs: number;
  connected: boolean;
  /** A real project of the workspace (a shared datastore box is not). */
  isProject: boolean;
}

export interface PEdge {
  id: string;
  from: string;
  to: string;
  kind: LineKind;
  label: string;
  tier: Tier;
  proof: MapEvidence[];
  raw: MapEdge;
}

export interface Graph {
  nodes: PNode[];
  byId: Map<string, PNode>;
  edges: PEdge[];
  edgeById: Map<string, PEdge>;
  connected: PNode[];
  unlinked: PNode[];
  outs: (id: string) => PEdge[];
  ins: (id: string) => PEdge[];
  totals: { projects: number; links: number; check: number; notConnected: number };
}

const KIND_OF: Record<MapEdge["type"], LineKind> = {
  http: "calls",
  data: "calls",
  queue: "jobs",
  lib: "embeds",
  deploy: "embeds",
  together: "calls",
};

const tierOf = (e: MapEdge): Tier =>
  e.confidence === "ambiguous" ? "check" : e.confidence === "inferred" ? "answer" : "code";

const NEEDS_YOU = new Set(["review", "paused", "mr"]);

/** The open tasks of a box: the tasks that name its project. */
export function tasksOf(view: MapView, node: MapNode): MapTask[] {
  return node.project === undefined
    ? []
    : view.tasks.filter((t) => t.projects.includes(node.project as string));
}

/** The role a project is drawn with: the owner's choice, else what its dependencies show. */
export function roleOf(view: MapView, node: MapNode): MapRole {
  return view.map.roles.find((r) => r.project === node.id)?.role ?? node.role ?? "service";
}

const ROLE_LANE: Record<MapRole, 0 | 1 | 2 | 3> = { app: 0, service: 1, queue: 2, worker: 3 };
const ROLE_NAME: Record<MapRole, string> = {
  app: "App",
  service: "Service",
  queue: "Queue",
  worker: "Worker",
};
const KIND_NAME: Record<string, string> = {
  library: "Library",
  database: "Database",
  queue: "Queue",
  cache: "Cache",
  outside: "Outside",
  connection: "Connection",
};

function laneOf(view: MapView, n: MapNode): { lane: 0 | 1 | 2 | 3; label: string; cls: PNode["roleClass"] } {
  if (n.kind === "project") {
    const r = roleOf(view, n);
    return { lane: ROLE_LANE[r], label: ROLE_NAME[r], cls: r };
  }
  const label = KIND_NAME[n.kind] ?? "Service";
  if (n.kind === "queue" || n.kind === "cache" || n.kind === "database") {
    return { lane: 2, label, cls: n.kind === "queue" ? "queue" : "" };
  }
  return { lane: 1, label, cls: "" };
}

/** Addresses a project calls that the owner named outside: shown as its outside services too. */
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

/** `/Users/name/Work/x` as `~/Work/x`: the first two folders of a home on macOS or Linux. */
export function homeShort(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const parts = path.split("/");
  if (parts[0] === "" && (parts[1] === "Users" || parts[1] === "home") && parts.length > 3) {
    return `~/${parts.slice(3).join("/")}`;
  }
  return path;
}

/** One workspace's map as the page draws it: boxes with their lane, lamp and counts, lines with their tier. */
export function buildGraph(view: MapView): Graph {
  const edges: PEdge[] = view.map.edges
    .filter((e) => e.type !== "together")
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      kind: KIND_OF[e.type],
      label: e.label,
      tier: tierOf(e),
      proof: e.evidence,
      raw: e,
    }));
  const outMap = new Map<string, PEdge[]>();
  const inMap = new Map<string, PEdge[]>();
  for (const e of edges) {
    outMap.set(e.from, [...(outMap.get(e.from) ?? []), e]);
    inMap.set(e.to, [...(inMap.get(e.to) ?? []), e]);
  }
  const outs = (id: string) => outMap.get(id) ?? [];
  const ins = (id: string) => inMap.get(id) ?? [];
  const nodes = view.map.nodes
    .map((n): PNode => {
      const { lane, label, cls } = laneOf(view, n);
      const tasks = tasksOf(view, n);
      const needsYou = tasks.some((t) => NEEDS_YOU.has(t.status));
      const running = tasks.filter((t) => t.status === "running").length;
      const check = outs(n.id).some((e) => e.tier === "check");
      const lamp: NodeLamp = needsYou || check ? "needs" : running > 0 ? "working" : "idle";
      const lampWord = needsYou
        ? "needs you"
        : running > 0
          ? `${running} ${running === 1 ? "agent" : "agents"} working`
          : check
            ? "to check"
            : "idle";
      const chips = n.stack ?? [];
      return {
        id: n.id,
        label: n.label,
        project: n.project,
        roleLabel: label,
        roleClass: cls,
        lane,
        stack: chips.filter((c) => !STORES.has(c)),
        stores: chips.filter((c) => STORES.has(c)),
        outside: usesOf(view, n),
        desc: n.sub ?? "",
        deploy: n.deploy,
        path: homeShort(view.projects.find((p) => p.id === n.project)?.path),
        // A running task wins over a line to check on the lamp, as in the mockup's two states.
        lamp: needsYou ? "needs" : running > 0 ? "working" : lamp,
        lampWord,
        tasks,
        ins: ins(n.id).length,
        outs: outs(n.id).length,
        connected: ins(n.id).length + outs(n.id).length > 0,
        isProject: n.project !== undefined,
      };
    })
    // A shared box nothing reaches is not drawn.
    .filter((n) => n.isProject || n.connected);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const shown = edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const connected = nodes.filter((n) => n.connected);
  const unlinked = nodes.filter((n) => !n.connected);
  return {
    nodes,
    byId,
    edges: shown,
    edgeById: new Map(shown.map((e) => [e.id, e])),
    connected,
    unlinked,
    outs: (id) => outs(id).filter((e) => byId.has(e.to)),
    ins: (id) => ins(id).filter((e) => byId.has(e.from)),
    totals: {
      projects: nodes.filter((n) => n.isProject).length,
      links: shown.length,
      check: shown.filter((e) => e.tier === "check").length,
      notConnected: unlinked.filter((n) => n.isProject).length,
    },
  };
}

/** Every line reached from a box, breadth first, following calls out or calls in. */
export function traceFrom(g: Graph, id: string, dir: "out" | "in"): string[] {
  const seen = new Set([id]);
  const used = new Set<string>();
  const list: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const n = queue.shift() as string;
    for (const e of dir === "out" ? g.outs(n) : g.ins(n)) {
      if (used.has(e.id)) continue;
      used.add(e.id);
      list.push(e.id);
      const next = dir === "out" ? e.to : e.from;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return list;
}

/** A line of the unanswered addresses: the Addresses dialog lists these. */
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

/** The estimate on the button: "~$0.30", "~$0.02" and under a cent "<$0.01". */
export function usdWords(usd: number): string {
  if (usd < 0.005) return "<$0.01";
  return `~$${usd.toFixed(2)}`;
}

/** `host` or `host:port` as the answer command takes it. */
export function addressText(e: Pick<MapEndpoint, "host" | "port">): string {
  return e.port === undefined ? e.host : `${e.host}:${e.port}`;
}
