import type { ReactNode } from "react";
import { arrowOf, badgePos, longestMid, type Pt, roundPath, shorten } from "./layout";
import { LINE_KIND_LABEL, type PEdge, type PNode } from "./model";

/** What a picture says about each line and box right now, from hover, pick and trace. */
export interface Focus {
  /** Lines kept bright. Absent: nothing is focused and every line is at rest. */
  edges: ReadonlySet<string> | null;
  hoverEdge: string | undefined;
  hoverNode: string | undefined;
  selEdge: string | undefined;
  selNode: string | undefined;
  trace: ReadonlySet<string>;
}

/** Derives what to light and what to dim. Mirrors the approved mockup's rules. */
export function focusOf(
  hover: { t: "node" | "edge"; id: string } | null,
  sel: { t: "node" | "edge"; id: string } | null,
  trace: readonly string[],
  touching: (id: string) => string[],
): Focus {
  const traceSet = new Set(trace);
  let edges: ReadonlySet<string> | null = null;
  if (hover?.t === "node") edges = new Set(touching(hover.id));
  else if (hover?.t === "edge") edges = new Set([hover.id]);
  else if (sel?.t === "edge") edges = new Set([sel.id]);
  else if (traceSet.size > 0) edges = traceSet;
  return {
    edges,
    hoverEdge: hover?.t === "edge" ? hover.id : undefined,
    hoverNode: hover?.t === "node" ? hover.id : undefined,
    selEdge: sel?.t === "edge" ? sel.id : undefined,
    selNode: sel?.t === "node" ? sel.id : undefined,
    trace: traceSet,
  };
}

export function Wires({
  edges,
  routes,
  w,
  h,
  focus,
  onPick,
  onHover,
}: {
  edges: readonly PEdge[];
  routes: ReadonlyMap<string, Pt[]>;
  w: number;
  h: number;
  focus: Focus;
  onPick: (id: string) => void;
  onHover: (id: string | undefined) => void;
}) {
  return (
    <svg className="wires" width={w} height={h} aria-hidden="true">
      {edges.map((e) => {
        const pts = routes.get(e.id);
        if (pts === undefined || pts.length < 2) return null;
        const on = focus.edges?.has(e.id) ?? false;
        const hot = on && (focus.hoverEdge !== undefined || focus.hoverNode !== undefined);
        const tr = focus.trace.has(e.id) && !(focus.hoverNode !== undefined && !on);
        const cls = [
          "edge",
          `k-${e.kind}`,
          `t-${e.tier}`,
          focus.edges !== null && !on ? "dim" : "",
          hot ? "hot" : "",
          tr ? "tr" : "",
          focus.selEdge === e.id ? "sel" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: lines are picked with the pointer; the rail and panel list the same lines for the keyboard
          // biome-ignore lint/a11y/noStaticElementInteractions: an SVG group that is a hit target
          <g
            key={e.id}
            className={cls}
            data-edge={e.id}
            style={{ pointerEvents: "auto" }}
            onClick={() => onPick(e.id)}
            onMouseEnter={() => onHover(e.id)}
            onMouseLeave={() => onHover(undefined)}
          >
            <path className="hit" d={roundPath(pts)} />
            <path className="ln" d={roundPath(shorten(pts))} />
            <path className="ar" d={arrowOf(pts)} />
          </g>
        );
      })}
    </svg>
  );
}

/** Numbers on a trace and the label of the hovered or picked line. */
export function Overlay({
  edges,
  routes,
  w,
  h,
  focus,
  numbered,
}: {
  edges: readonly PEdge[];
  routes: ReadonlyMap<string, Pt[]>;
  w: number;
  h: number;
  focus: Focus;
  /** Line ids in order: each gets its number. */
  numbered: readonly string[];
}): ReactNode {
  return (
    <div className="ov" style={{ width: w, height: h }}>
      {numbered.map((id, i) => {
        const pts = routes.get(id);
        if (pts === undefined) return null;
        const [x, y] = badgePos(pts);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the same line may be a step twice
          <div key={`${id}:${i}`} className="badge" style={{ left: x, top: y }}>
            {i + 1}
          </div>
        );
      })}
      {edges.map((e) => {
        const show = focus.hoverEdge === e.id || focus.selEdge === e.id;
        const pts = routes.get(e.id);
        if (!show || pts === undefined) return null;
        const [x, y] = longestMid(pts);
        return (
          <div key={e.id} className="pill" style={{ left: x, top: y }}>
            {e.label}
            <span className="mono">{LINE_KIND_LABEL[e.kind].toLowerCase()}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The chips of a box: what it stores data in, then the outside services it uses (dashed). */
export function BoxChips({ node }: { node: PNode }) {
  return (
    <div className="chips">
      {node.stores.map((s) => (
        <span key={s} className="chip">
          {s}
        </span>
      ))}
      {node.outside.map((s) => (
        <span key={s} className="chip out">
          {s}
        </span>
      ))}
    </div>
  );
}
