import type { Diagram } from "@majhi/shared";
import { BOX_H, BOX_W, type Box, type Layout } from "../types";
import { routeEdges } from "./route";

/** The room one box takes on a ring: its width plus a gap. */
const SLOT = BOX_W + 36;
const RING = 250;

/**
 * A mind map: the focus (else the box with the most lines) in the middle and everything else on rings
 * around it, nearest first. A box that no line reaches goes on the outer ring. No dagre: a small
 * deterministic placer, so the same diagram always looks the same.
 */
export const radial: Layout = (d: Diagram) => {
  const degree = new Map<string, number>(d.nodes.map((n) => [n.id, 0]));
  const next = new Map<string, string[]>(d.nodes.map((n) => [n.id, []]));
  for (const e of d.edges) {
    if (e.from === e.to) continue;
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    next.get(e.from)?.push(e.to);
    next.get(e.to)?.push(e.from);
  }
  const centre =
    d.focus ?? d.nodes.toSorted((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))[0]?.id ?? "";
  const ring = new Map<string, number>([[centre, 0]]);
  const parent = new Map<string, string>();
  let frontier = [centre];
  for (let depth = 1; frontier.length > 0; depth++) {
    const found: string[] = [];
    for (const id of frontier) {
      for (const other of next.get(id) ?? []) {
        if (!ring.has(other)) {
          ring.set(other, depth);
          parent.set(other, id);
          found.push(other);
        }
      }
    }
    frontier = found;
  }
  const outer = Math.max(0, ...ring.values()) + 1;
  for (const n of d.nodes) if (!ring.has(n.id)) ring.set(n.id, outer);

  const nodes = new Map<string, Box>();
  const rings = new Map<number, string[]>();
  for (const n of d.nodes) rings.set(ring.get(n.id) ?? 0, [...(rings.get(ring.get(n.id) ?? 0) ?? []), n.id]);
  const angles = new Map<string, number>();
  for (const depth of [...rings.keys()].toSorted((a, b) => a - b)) {
    const ids = rings.get(depth) ?? [];
    if (depth === 0) {
      for (const id of ids) nodes.set(id, { x: -BOX_W / 2, y: -BOX_H / 2, w: BOX_W, h: BOX_H });
      continue;
    }
    // Wide enough that the boxes of a crowded ring do not touch.
    const radius = Math.max(depth * RING, (ids.length * SLOT) / (2 * Math.PI));
    if (depth === 1 || depth === outer) {
      ids.forEach((id, i) => {
        angles.set(id, -Math.PI / 2 + (2 * Math.PI * i) / ids.length);
      });
    } else {
      // Children stand around their parent's direction.
      const byParent = new Map<string, string[]>();
      for (const id of ids)
        byParent.set(parent.get(id) ?? "", [...(byParent.get(parent.get(id) ?? "") ?? []), id]);
      for (const [p, kin] of byParent) {
        const base = angles.get(p) ?? 0;
        kin.forEach((id, j) => {
          angles.set(id, base + (j - (kin.length - 1) / 2) * 0.42);
        });
      }
    }
    for (const id of ids) {
      const angle = angles.get(id) ?? 0;
      nodes.set(id, {
        x: Math.cos(angle) * radius * 1.35 - BOX_W / 2,
        y: Math.sin(angle) * radius - BOX_H / 2,
        w: BOX_W,
        h: BOX_H,
      });
    }
  }
  return { nodes, groups: new Map(), edges: routeEdges(d, nodes), rules: [] };
};
