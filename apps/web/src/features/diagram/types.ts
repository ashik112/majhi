import type { Diagram } from "@majhi/shared";

/** Every box on the canvas is this size, so a longer label is cut, never wrapped, and layouts need no text measuring. */
export const BOX_W = 190;
export const BOX_H = 68;
/** A card that carries chips is taller. */
export const CARD_H = 112;

export interface Point {
  x: number;
  y: number;
}

/** A place on the canvas: the top-left corner and the size. */
export interface Box extends Point {
  w: number;
  h: number;
}

/** A line's path: a quadratic curve from `from` through `via` to `to`, with the label at `mid`. */
export interface EdgePath {
  from: Point;
  via: Point;
  to: Point;
  mid: Point;
}

/** A plain line drawn behind everything: a lifeline of a sequence, the axis of a timeline. */
export interface Rule {
  from: Point;
  to: Point;
  dash?: string | undefined;
}

/** What a layout returns: where every box goes, the frames of groups, how each line runs. */
export interface Positioned {
  /** Boxes by node id. */
  nodes: Map<string, Box>;
  /** Frames of the nodes that hold others (`group`), by node id. */
  groups: Map<string, Box>;
  /** Lines by their key (`edgeKey`). */
  edges: Map<string, EdgePath>;
  rules: Rule[];
}

/**
 * A layout turns a diagram into positions. It is pure and the same input gives the same output.
 * To add one: write a file in `layouts/`, then add one line to the registry in `layouts/index.ts`.
 */
export type Layout = (diagram: Diagram) => Positioned;
