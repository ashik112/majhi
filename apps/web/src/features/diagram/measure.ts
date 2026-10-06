import type { DiagramEdge, DiagramNode } from "@majhi/shared";

/**
 * How big text is, so a layout can give a box or a label the room its words need and the canvas never has to
 * cut or overflow them. Measured with the page's own fonts once they load; a rough width per letter where
 * there is no canvas (tests).
 */

const SANS = '"IBM Plex Sans", "Helvetica Neue", system-ui, sans-serif';

/** The type of a box and a label. Layout and the canvas read the same numbers. */
export const TYPE = {
  kind: { font: `500 11px ${SANS}`, line: 15 },
  title: { font: `600 13px ${SANS}`, line: 18 },
  sub: { font: `400 12px ${SANS}`, line: 16 },
  label: { font: `400 12px ${SANS}`, line: 16 },
  note: { font: `400 11px ${SANS}`, line: 14 },
  action: { font: `400 12px ${SANS}`, line: 16 },
} as const;

let canvas: CanvasRenderingContext2D | null | undefined;
function context(): CanvasRenderingContext2D | null {
  if (canvas !== undefined) return canvas;
  canvas =
    typeof document === "undefined" ? null : (document.createElement("canvas").getContext("2d") ?? null);
  return canvas;
}

export function textWidth(text: string, font: string): number {
  const ctx = context();
  if (ctx === null) {
    const size = Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "12");
    return text.length * size * 0.56;
  }
  if (ctx.font !== font) ctx.font = font;
  return ctx.measureText(text).width;
}

/** The lines `text` takes in `width` pixels when it wraps at spaces, and a word too long for a line breaks. */
export function wrappedLines(text: string, font: string, width: number): number {
  const room = Math.max(40, width);
  let lines = 1;
  let used = 0;
  const space = textWidth(" ", font);
  for (const word of text.split(" ")) {
    const w = textWidth(word, font);
    if (w > room) {
      const extra = Math.ceil((used === 0 ? w : used + space + w) / room) - 1;
      lines += extra;
      used = w % room;
      continue;
    }
    if (used === 0) used = w;
    else if (used + space + w <= room) used += space + w;
    else {
      lines += 1;
      used = w;
    }
  }
  return lines;
}

/** The width of a content-sized box, and the padding around its text. */
export const NODE_W = 152;
export const NODE_PAD_X = 12;
export const NODE_PAD_Y = 10;
/** The line a box can carry under its text, like "Open its wiki". */
const ACTION_ROW = 22;

/** A little room under the measure: a browser may wrap a hair earlier than the canvas says. */
const SLACK = 6;

export function nodeSize(node: DiagramNode, action: boolean): { w: number; h: number } {
  const inner = NODE_W - 2 * NODE_PAD_X - SLACK;
  let h = 2 * NODE_PAD_Y;
  if (node.kind !== undefined) h += TYPE.kind.line;
  h += wrappedLines(node.label, TYPE.title.font, inner) * TYPE.title.line;
  if (node.sub !== undefined) h += wrappedLines(node.sub, TYPE.sub.font, inner) * TYPE.sub.line;
  if (action) h += ACTION_ROW;
  return { w: NODE_W, h: Math.max(52, h) };
}

/** The most a label is wide before it wraps. */
const LABEL_MAX = 200;
const LABEL_PAD_X = 8;
const LABEL_PAD_Y = 4;

/** The pill of a line's label: wide enough for its longest line, tall enough for all of them. */
export function labelSize(edge: Pick<DiagramEdge, "label" | "note">): { w: number; h: number } {
  const label = edge.label ?? "";
  const labelW = Math.min(LABEL_MAX, textWidth(label, TYPE.label.font) + SLACK);
  const noteW =
    edge.note === undefined ? 0 : Math.min(LABEL_MAX, textWidth(edge.note, TYPE.note.font) + SLACK);
  const w = Math.ceil(Math.max(labelW, noteW)) + 2 * LABEL_PAD_X;
  const lines = wrappedLines(label, TYPE.label.font, w - 2 * LABEL_PAD_X - SLACK);
  const noteLines =
    edge.note === undefined ? 0 : wrappedLines(edge.note, TYPE.note.font, w - 2 * LABEL_PAD_X - SLACK);
  return { w, h: lines * TYPE.label.line + noteLines * TYPE.note.line + 2 * LABEL_PAD_Y };
}

/** Waits for the page's fonts, so measuring sees them. */
export async function fontsReady(): Promise<void> {
  if (typeof document === "undefined" || document.fonts === undefined) return;
  try {
    await document.fonts.ready;
    // A measure taken before the fonts loaded used another face.
    canvas = undefined;
  } catch {
    // Without the fonts the fallback face is measured.
  }
}

/**
 * A message label without the number a writer may have put in front of it ("1. connect.start" is
 * "connect.start"): the badge on the line is the only number.
 */
export function withoutStepNumber(label: string): string {
  let i = 0;
  while (i < label.length && label.charCodeAt(i) >= 48 && label.charCodeAt(i) <= 57) i++;
  const mark = label[i];
  if (i === 0 || (mark !== "." && mark !== ")") || label[i + 1] !== " ") return label;
  return label.slice(i + 2).trimStart();
}
