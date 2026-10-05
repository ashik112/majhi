import { type Diagram, edgeKey } from "@majhi/shared";
import { useMemo } from "react";
import { layouts } from "./layouts";
import type { Positioned } from "./types";

/**
 * The part of a diagram a layout reads: ids, groups, who connects to whom and the layout's own options.
 * Labels, tones and everything a page decorates are left out, so changing them never lays out again.
 */
function structure(d: Diagram): string {
  return JSON.stringify([
    d.layout,
    d.focus ?? null,
    d.actors ?? null,
    d.nodes.map((n) => [n.id, n.group ?? null]),
    d.edges.map((e, i) => [edgeKey(e, i), e.from, e.to, e.type === "together" ? 1 : 0]),
  ]);
}

/** A short hash of a string, for a cache key. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

const KEEP = 40;
const cache = new Map<string, Positioned>();

/** Lays a diagram out, once per structure: the same diagram on another render, or in another room item, is a lookup. */
export function position(d: Diagram): Positioned {
  const key = hash(structure(d));
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const placed = layouts[d.layout](d);
  cache.set(key, placed);
  if (cache.size > KEEP) cache.delete(cache.keys().next().value ?? key);
  return placed;
}

/** `position` for a component: recomputed only when the diagram's structure changes. */
export function usePositioned(d: Diagram): Positioned {
  const key = hash(structure(d));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the diagram's structure; labels do not matter.
  return useMemo(() => position(d), [key]);
}
