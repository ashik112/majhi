import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  GRAPHIFY_GRAPH_FILE,
  type GraphifyGraph,
  GraphifyGraphSchema,
  type GraphifyLink,
  type GraphifyNode,
} from "@majhi/shared";

/**
 * Questions about a project's code graph, answered from the cached `graph.json` (what graphify's own
 * `query`, `explain` and `path` answer, in code, with no process to start). Read-only. Plain text out,
 * short enough for an agent's context.
 */

const MAX_GRAPH_BYTES = 64 * 1024 * 1024;
const LIST_MAX = 12;
/** Longest path searched, in steps. */
const PATH_MAX = 12;
/** Relations that are structure, not behaviour: listed last, and a path prefers the others. */
const STRUCTURE = new Set(["contains", "method", "defines"]);

export class Graph {
  readonly byId = new Map<string, GraphifyNode>();
  private readonly out = new Map<string, GraphifyLink[]>();
  private readonly inn = new Map<string, GraphifyLink[]>();

  constructor(data: GraphifyGraph) {
    for (const n of data.nodes) this.byId.set(n.id, n);
    for (const l of data.links) {
      if (!this.byId.has(l.source) || !this.byId.has(l.target)) continue;
      this.out.set(l.source, [...(this.out.get(l.source) ?? []), l]);
      this.inn.set(l.target, [...(this.inn.get(l.target) ?? []), l]);
    }
  }

  get size(): number {
    return this.byId.size;
  }

  outgoing(id: string): readonly GraphifyLink[] {
    return this.out.get(id) ?? [];
  }

  incoming(id: string): readonly GraphifyLink[] {
    return this.inn.get(id) ?? [];
  }

  degree(id: string): number {
    return this.outgoing(id).length + this.incoming(id).length;
  }

  /** Nodes a name points at: an id or label equal to it first (case aside), else labels that contain it. */
  find(name: string): GraphifyNode[] {
    const want = name.trim().toLowerCase();
    if (want === "") return [];
    const all = [...this.byId.values()];
    const exact = all.filter((n) => n.id.toLowerCase() === want || bare(n.label) === bare(want));
    const found = exact.length > 0 ? exact : all.filter((n) => n.label.toLowerCase().includes(want));
    return found.toSorted((a, b) => this.degree(b.id) - this.degree(a.id) || a.id.localeCompare(b.id));
  }

  /** Shortest chain of links from a to b, following direction first and either direction when that fails. */
  path(from: string, to: string): { node: string; via?: GraphifyLink; forward: boolean }[] | undefined {
    for (const directed of [true, false]) {
      const prev = new Map<string, { id: string; link: GraphifyLink; forward: boolean }>();
      const seen = new Set([from]);
      let frontier = [from];
      for (let depth = 0; depth < PATH_MAX && frontier.length > 0 && !seen.has(to); depth++) {
        const next: string[] = [];
        for (const id of frontier) {
          const steps = [
            ...this.outgoing(id).map((l) => ({ link: l, other: l.target, forward: true })),
            ...(directed ? [] : this.incoming(id).map((l) => ({ link: l, other: l.source, forward: false }))),
          ].toSorted(
            (a, b) => Number(STRUCTURE.has(a.link.relation)) - Number(STRUCTURE.has(b.link.relation)),
          );
          for (const s of steps) {
            if (seen.has(s.other)) continue;
            seen.add(s.other);
            prev.set(s.other, { id, link: s.link, forward: s.forward });
            next.push(s.other);
          }
        }
        frontier = next;
      }
      if (!seen.has(to)) continue;
      const chain: { node: string; via?: GraphifyLink; forward: boolean }[] = [];
      for (let at = to; at !== from; ) {
        const p = prev.get(at) as { id: string; link: GraphifyLink; forward: boolean };
        chain.unshift({ node: at, via: p.link, forward: p.forward });
        at = p.id;
      }
      return [{ node: from, forward: true }, ...chain];
    }
    return undefined;
  }
}

const cache = new Map<string, { stamp: string; graph: Graph }>();

/** The cached graph of a project folder, or undefined when there is none or it is not readable. */
export async function loadGraph(folder: string): Promise<Graph | undefined> {
  const file = join(folder, GRAPHIFY_GRAPH_FILE);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_GRAPH_BYTES) return undefined;
    const stamp = `${info.size}:${info.mtimeMs}`;
    const hit = cache.get(file);
    if (hit?.stamp === stamp) return hit.graph;
    const parsed = GraphifyGraphSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) return undefined;
    const graph = new Graph(parsed.data);
    cache.set(file, { stamp, graph });
    if (cache.size > 24) cache.delete(cache.keys().next().value ?? file);
    return graph;
  } catch {
    return undefined;
  }
}

/** A label as a person writes the name: no `()` after it, no `.` before a method. */
function bare(label: string): string {
  let out = label.trim().toLowerCase();
  if (out.endsWith("()")) out = out.slice(0, -2);
  if (out.startsWith(".")) out = out.slice(1);
  return out;
}

const line = (at: string) => (at.startsWith("L") ? at.slice(1) : at);
const where = (n: GraphifyNode) =>
  n.source_file === undefined
    ? ""
    : ` (${n.source_file}${n.source_location === undefined ? "" : `:${line(n.source_location)}`})`;
const name = (n: GraphifyNode) => `${n.label === "" ? n.id : n.label}${where(n)}`;
const tier = (l: GraphifyLink) =>
  l.confidence === undefined || l.confidence === "EXTRACTED" ? "" : ` [${l.confidence.toLowerCase()}]`;

function pick(graph: Graph, text: string): { node: GraphifyNode } | { problem: string } {
  const found = graph.find(text);
  const first = found[0];
  if (first === undefined) {
    return { problem: `Nothing in this project's code graph matches "${text}". Try \`search\`.` };
  }
  // Two nodes with the same name (a function in two files): the caller says which, by its id.
  const twins = found.filter((n) => n.id !== text && bare(n.label) === bare(first.label));
  if (twins.length > 1 && !found.some((n) => n.id === text)) {
    const shown = twins.slice(0, 6).map((n) => `${n.id} ${where(n)}`);
    return { problem: `"${text}" matches ${twins.length} nodes: ${shown.join("; ")}. Name one by its id.` };
  }
  return { node: found.find((n) => n.id === text) ?? first };
}

function list(
  title: string,
  links: readonly GraphifyLink[],
  other: (l: GraphifyLink) => GraphifyNode | undefined,
): string[] {
  if (links.length === 0) return [];
  const sorted = links.toSorted(
    (a, b) => Number(STRUCTURE.has(a.relation)) - Number(STRUCTURE.has(b.relation)),
  );
  const lines = sorted.slice(0, LIST_MAX).flatMap((l) => {
    const n = other(l);
    return n === undefined ? [] : [`  ${l.relation}${tier(l)} ${name(n)}`];
  });
  const more = links.length - LIST_MAX;
  return [`${title}:`, ...lines, ...(more > 0 ? [`  and ${more} more`] : [])];
}

/** What a node is, and what it calls and is called by. */
export function neighbors(graph: Graph, text: string): string {
  const got = pick(graph, text);
  if ("problem" in got) return got.problem;
  const n = got.node;
  const body = [
    ...list("Calls or uses", graph.outgoing(n.id), (l) => graph.byId.get(l.target)),
    ...list("Called or used by", graph.incoming(n.id), (l) => graph.byId.get(l.source)),
  ];
  return [`${name(n)}`, ...(body.length === 0 ? ["It has no links in the graph."] : body)].join("\n");
}

/** `neighbors` plus where the node sits: its community and how connected it is. */
export function explain(graph: Graph, text: string): string {
  const got = pick(graph, text);
  if ("problem" in got) return got.problem;
  const n = got.node;
  const head = [
    name(n),
    `Kind: ${n.file_type ?? "code"}${n.community_name === undefined ? "" : `; group: ${n.community_name}`}; ${graph.degree(n.id)} links.`,
  ];
  return [...head, neighbors(graph, n.id).split("\n").slice(1).join("\n")].join("\n");
}

/** The shortest chain between two nodes, step by step. */
export function path(graph: Graph, from: string, to: string): string {
  const a = pick(graph, from);
  if ("problem" in a) return a.problem;
  const b = pick(graph, to);
  if ("problem" in b) return b.problem;
  const chain = graph.path(a.node.id, b.node.id);
  if (chain === undefined)
    return `No path of up to ${PATH_MAX} steps from ${name(a.node)} to ${name(b.node)}.`;
  const lines = chain.map((step, i) => {
    const n = graph.byId.get(step.node) as GraphifyNode;
    if (i === 0 || step.via === undefined) return `${i + 1}. ${name(n)}`;
    return `${i + 1}. ${step.forward ? "-" : "<-"}${step.via.relation}${tier(step.via)}${step.forward ? "->" : "-"} ${name(n)}`;
  });
  return lines.join("\n");
}

/** Words of a question: runs of letters and digits, lower case, two characters or more. */
function words(text: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const ch of `${text.toLowerCase()} `) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) word += ch;
    else {
      if (word.length >= 2) out.push(word);
      word = "";
    }
  }
  return out;
}

/** Nodes whose name or file matches the words of a question, best connected first. */
export function search(graph: Graph, question: string): string {
  const want = words(question);
  if (want.length === 0) return "Say what to look for: a function, a file or a word from its name.";
  const scored = [...graph.byId.values()]
    .map((n) => {
      const label = words(n.label).join(" ");
      const file = (n.source_file ?? "").toLowerCase();
      const hits =
        want.filter((w) => label.includes(w)).length * 2 + want.filter((w) => file.includes(w)).length;
      return { n, hits };
    })
    .filter((s) => s.hits > 0 && s.n.file_type !== "concept")
    .toSorted(
      (a, b) =>
        b.hits - a.hits || graph.degree(b.n.id) - graph.degree(a.n.id) || a.n.id.localeCompare(b.n.id),
    );
  if (scored.length === 0) return `Nothing in this project's code graph matches "${question.slice(0, 80)}".`;
  return scored
    .slice(0, LIST_MAX)
    .map((s) => `${name(s.n)}: ${graph.degree(s.n.id)} links`)
    .join("\n");
}
