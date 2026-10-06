import type { OverviewLayout } from "./layout";
import type { Graph, PNode } from "./model";
import type { UiState } from "./use-map-state";
import { BoxChips, focusOf, Overlay, Wires } from "./wires";

interface Acts {
  pickNode: (id: string) => void;
  openProject: (id: string) => void;
  selectEdge: (id: string) => void;
  setHover: (h: { t: "node" | "edge"; id: string } | null) => void;
  addStep: (edgeId: string) => void;
}

/** The state word beside a box's badge: only when there is something to say. */
function stateOf(n: PNode): string | undefined {
  if (n.lamp === "idle") return undefined;
  if (n.lamp === "working") return "working";
  return n.lampWord === "needs you" ? "needs you" : "to check";
}

/**
 * The Overview picture: lane titles, the boxes, the wires and their numbers. It draws what the layout
 * says and re-renders on hover and pick, but never lays out again.
 */
export function OverviewWorld({
  graph,
  layout,
  s,
  acts,
}: {
  graph: Graph;
  layout: OverviewLayout;
  s: UiState;
  acts: Acts;
}) {
  const composing = s.compose !== null;
  const composeEdges = (s.compose?.steps ?? []).flatMap((st) => (st.edge === undefined ? [] : [st.edge]));
  const numbered = composing ? composeEdges : (s.trace?.edges ?? []);
  const focus = focusOf(s.hover, s.sel, numbered, (id) =>
    [...graph.ins(id), ...graph.outs(id)].map((e) => e.id),
  );
  const q = s.q.trim().toLowerCase();
  const nodeSet = new Set<string>();
  if (focus.edges !== null) {
    for (const id of focus.edges) {
      const e = graph.edgeById.get(id);
      if (e !== undefined) {
        nodeSet.add(e.from);
        nodeSet.add(e.to);
      }
    }
  }
  const edges = graph.edges.filter((e) => layout.routes.has(e.id));
  return (
    <>
      <Wires
        edges={edges}
        routes={layout.routes}
        w={layout.w}
        h={layout.h}
        focus={focus}
        onPick={(id) => (composing ? acts.addStep(id) : acts.selectEdge(id))}
        onHover={(id) => acts.setHover(id === undefined ? null : { t: "edge", id })}
      />
      {layout.tags.map((t) => (
        <div key={t.text} className="gtag" style={{ left: t.x, top: -26 }}>
          {t.text}
        </div>
      ))}
      {graph.connected.map((n) => {
        const p = layout.nodes.get(n.id);
        if (p === undefined) return null;
        const dimFocus =
          focus.edges !== null &&
          !nodeSet.has(n.id) &&
          focus.hoverNode !== n.id &&
          !(focus.selNode === n.id && focus.trace.size === 0);
        const dim = dimFocus || (q !== "" && !n.label.toLowerCase().includes(q));
        const st = stateOf(n);
        const cls = ["node", `lit-${n.lamp}`, focus.selNode === n.id ? "sel" : "", dim ? "dim" : ""]
          .filter(Boolean)
          .join(" ");
        return (
          // biome-ignore lint/a11y/useSemanticElements: a box holds a badge and chips, which a button may not
          <div
            key={n.id}
            role="button"
            tabIndex={0}
            aria-label={`${n.label}, ${n.roleLabel}. Click to trace, double-click to open.`}
            className={cls}
            data-node={n.id}
            style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
            onClick={(e) => {
              if (composing) return;
              if (e.detail >= 2) acts.openProject(n.id);
              else acts.pickNode(n.id);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.stopPropagation();
              if (focus.selNode === n.id) acts.openProject(n.id);
              else acts.pickNode(n.id);
            }}
            onMouseEnter={() => acts.setHover({ t: "node", id: n.id })}
            onMouseLeave={() => acts.setHover(null)}
          >
            <div className="n-top">
              <span className={`bdg ${n.roleClass}`}>{n.roleLabel}</span>
              {st !== undefined && (
                <span className={`st ${n.lamp}`}>
                  <i className={`lamp ${n.lamp}`} />
                  {st}
                </span>
              )}
            </div>
            <div className="n-name">{n.label}</div>
            <BoxChips node={n} />
          </div>
        );
      })}
      <Overlay
        edges={edges}
        routes={layout.routes}
        w={layout.w}
        h={layout.h}
        focus={focus}
        numbered={numbered}
      />
    </>
  );
}
