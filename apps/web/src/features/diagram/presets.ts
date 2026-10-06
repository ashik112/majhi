import type { DiagramEdge, DiagramEdgeType, DiagramTone } from "@majhi/shared";

/**
 * How things are drawn, as tables. Adding a kind of line or a tone is one entry here: the canvas reads these
 * and nothing else. Colors are the message palette (never a lamp hue, see DESIGN.md).
 */

/** The color of a box's tag and of a tone on a line. */
export const TONE_COLOR: Record<DiagramTone, string> = {
  neutral: "var(--c-fg-muted)",
  good: "var(--c-green)",
  warn: "var(--c-amber)",
  bad: "var(--c-red)",
  accent: "var(--c-accent-text)",
};

export interface EdgePreset {
  color: string;
  dash: string | undefined;
  /** The words in the legend. */
  legend: string;
}

/** The kinds of line. `step` is a plain process: one thing, then the next. */
export const EDGE_PRESETS: Record<DiagramEdgeType, EdgePreset> = {
  http: { color: "var(--c-blue)", dash: undefined, legend: "calls (HTTP)" },
  queue: { color: "var(--c-violet)", dash: "6 5", legend: "jobs and queue" },
  data: { color: "var(--c-green)", dash: undefined, legend: "reads and writes data" },
  lib: { color: "var(--c-fg-muted)", dash: "2 5", legend: "uses as a library" },
  step: { color: "var(--c-fg-soft)", dash: undefined, legend: "then" },
  deploy: { color: "var(--c-fg-faint)", dash: "9 5", legend: "runs together" },
  together: { color: "var(--c-fg-dim)", dash: "2 4", legend: "changes together" },
};

/** The color of the small word on top of a box, by what the box is. Any other word is neutral. */
const KIND_COLOR: Record<string, string> = {
  frontend: "var(--c-blue)",
  backend: "var(--c-blue)",
  auth: "var(--c-blue)",
  realtime: "var(--c-blue)",
  site: "var(--c-blue)",
  worker: "var(--c-violet)",
  queue: "var(--c-violet)",
  voice: "var(--c-violet)",
  cache: "var(--c-green)",
  database: "var(--c-green)",
  store: "var(--c-green)",
};

/** A box's tag color: its tone when it has one, else the color of its kind. */
export function kindColor(kind: string | undefined, tone: DiagramTone | undefined): string {
  if (tone !== undefined) return TONE_COLOR[tone];
  return (kind === undefined ? undefined : KIND_COLOR[kind.toLowerCase()]) ?? "var(--c-fg-muted)";
}

/** What a legend can explain: a kind of line, or how sure a line is, or a message's number. */
export type LegendKey = DiagramEdgeType | "proven" | "guessed" | "step";

/** The legend of a diagram: the kinds of line it uses, then guessed lines when it has any; a sequence explains its marks. */
export function legendOf(spec: {
  layout: string;
  edges: readonly Pick<DiagramEdge, "type" | "style">[];
}): LegendKey[] {
  const guessed = spec.edges.some((e) => e.style === "dotted");
  if (spec.layout === "sequence") return guessed ? ["proven", "guessed", "step"] : ["proven", "step"];
  const used = (["http", "queue", "data", "lib", "step", "deploy", "together"] as const).filter((t) =>
    spec.edges.some((e) => e.type === t),
  );
  return guessed ? [...used, "guessed"] : used;
}

const DASH = { solid: undefined, dashed: "7 5", dotted: "2 4" } as const;

export interface EdgeLook {
  color: string;
  dash: string | undefined;
  arrowEnd: boolean;
  arrowStart: boolean;
}

/** What one line looks like: its own style and tone win over its kind's preset. */
export function edgeLook(edge: Pick<DiagramEdge, "type" | "style" | "tone" | "arrow">): EdgeLook {
  const preset = edge.type === undefined ? undefined : EDGE_PRESETS[edge.type];
  const arrow = edge.arrow ?? "end";
  return {
    color: edge.tone === undefined ? (preset?.color ?? "var(--c-fg-muted)") : TONE_COLOR[edge.tone],
    dash: edge.style === undefined ? preset?.dash : DASH[edge.style],
    arrowEnd: arrow === "end" || arrow === "both",
    arrowStart: arrow === "both",
  };
}
