import { type Diagram, edgeKey } from "@majhi/shared";
import { useEffect, useState } from "react";
import { layouts } from "./layouts";
import type { Positioned } from "./types";

/**
 * The part of a diagram a layout reads: ids, groups, who connects to whom, the words that size a box or a
 * label, and the layout's own options. Tones and everything a page decorates are left out, so changing them
 * never lays out again.
 */
function structure(d: Diagram): string {
  return JSON.stringify([
    d.layout,
    d.focus ?? null,
    d.actors ?? null,
    d.nodes.map((n) => [n.id, n.group ?? null, n.rank ?? null, n.kind ?? null, n.label, n.sub ?? null]),
    d.edges.map((e, i) => [
      edgeKey(e, i),
      e.from,
      e.to,
      e.type === "together" ? 1 : 0,
      e.label ?? null,
      e.note ?? null,
    ]),
  ]);
}

/** A short hash of a string, for a cache key. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

const KEEP = 40;
const cache = new Map<string, Promise<Positioned>>();

/**
 * Lays a diagram out, once per structure: the same diagram on another render, or in another room item, is a
 * lookup. `action` names the boxes that carry a row under their text, which makes them taller.
 */
export function position(d: Diagram, action: ReadonlySet<string> = new Set()): Promise<Positioned> {
  const key = hash(`${structure(d)}|${[...action].sort().join(",")}`);
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const placed = Promise.resolve(layouts[d.layout](d, { action }));
  cache.set(key, placed);
  placed.catch(() => cache.delete(key));
  if (cache.size > KEEP) cache.delete(cache.keys().next().value ?? key);
  return placed;
}

/** `position` for a component: laid out again only when the diagram's structure changes. Undefined while it is being laid out. */
export function usePositioned(d: Diagram, action: ReadonlySet<string>): Positioned | undefined {
  const key = hash(`${structure(d)}|${[...action].sort().join(",")}`);
  const [done, setDone] = useState<{ key: string; value: Positioned }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the diagram's structure; labels do not matter.
  useEffect(() => {
    let live = true;
    void position(d, action).then((value) => {
      if (live) setDone({ key, value });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return done?.key === key ? done.value : undefined;
}
