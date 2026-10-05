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
  queue: { color: "var(--c-violet)", dash: "6 5", legend: "jobs / queue" },
  data: { color: "var(--c-green)", dash: undefined, legend: "reads / writes data" },
  lib: { color: "var(--c-fg-muted)", dash: "2 5", legend: "uses as a library" },
  step: { color: "var(--c-fg-soft)", dash: undefined, legend: "then" },
  deploy: { color: "var(--c-fg-faint)", dash: "9 5", legend: "runs together" },
  together: { color: "var(--c-fg-dim)", dash: "2 4", legend: "changes together" },
};

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
