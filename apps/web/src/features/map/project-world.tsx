import type { ProjectLayout } from "./layout";
import { type Graph, type PNode, TIER_LABEL, type Tier } from "./model";
import { ProjectInside } from "./project-inside";
import type { UiState } from "./use-map-state";
import { BoxChips, focusOf, Overlay, Wires } from "./wires";

interface Acts {
  focusProject: (id: string) => void;
  selectEdge: (id: string) => void;
  setHover: (h: { t: "node" | "edge"; id: string } | null) => void;
}

const short = (s: string) => (s.length > 20 ? `${s.slice(0, 19)}…` : s);

/**
 * The Project view: who uses the project on the left, the project's card in the middle (proof tally and
 * counts), what it talks to on the right. A neighbour is a button that recenters on it.
 */
export function ProjectWorld({
  graph,
  node,
  layout,
  s,
  acts,
}: {
  graph: Graph;
  node: PNode;
  layout: ProjectLayout;
  s: UiState;
  acts: Acts;
}) {
  const edges = [...graph.ins(node.id), ...graph.outs(node.id)];
  const focus = focusOf(s.hover, s.sel, [], () => []);
  const { cw, ch, mw, rx } = layout.size;
  const tally = (t: Tier) => edges.filter((e) => e.tier === t).length;
  const neighbor = (item: { edge: string; node: string; y: number }, x: number) => {
    const n = graph.byId.get(item.node);
    const e = graph.edgeById.get(item.edge);
    if (n === undefined || e === undefined) return null;
    return (
      // biome-ignore lint/a11y/useSemanticElements: a neighbour holds a badge and a line of text
      <div
        key={item.edge}
        role="button"
        tabIndex={0}
        aria-label={`${n.label}. Open it as the project.`}
        className={`node nb lit-${n.lamp}`}
        data-nb={n.id}
        style={{ left: x, top: item.y, width: cw, height: ch }}
        onClick={() => acts.focusProject(n.id)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") acts.focusProject(n.id);
        }}
        onMouseEnter={() => acts.setHover({ t: "edge", id: e.id })}
        onMouseLeave={() => acts.setHover(null)}
      >
        <div className="n-top">
          <span className="n-name">{short(n.label)}</span>
        </div>
        <div className="n-sub">
          <span className={`bdg ${n.roleClass}`} style={{ height: 18 }}>
            {n.roleLabel}
          </span>
          {e.label}
        </div>
      </div>
    );
  };
  const st =
    node.lamp === "idle"
      ? { cls: "", text: "idle", lamp: "idle" }
      : {
          cls: node.lamp,
          text: node.lampWord === "to check" ? "1 to check" : node.lampWord,
          lamp: node.lamp,
        };
  const chips = [...node.stack, ...node.stores];
  const mid = layout.h / 2;
  return (
    <>
      <Wires
        edges={edges}
        routes={layout.routes}
        w={layout.w}
        h={layout.h}
        focus={focus}
        onPick={acts.selectEdge}
        onHover={(id) => acts.setHover(id === undefined ? null : { t: "edge", id })}
      />
      <div className="gtag" style={{ left: 0, top: -26 }}>
        Used by
      </div>
      <div className="gtag" style={{ left: layout.card.x, top: -26 }}>
        Project
      </div>
      <div className="gtag" style={{ left: rx, top: -26 }}>
        Talks to
      </div>
      {layout.left.map((i) => neighbor(i, 0))}
      {layout.right.map((i) => neighbor(i, rx))}
      {layout.left.length === 0 && (
        <div className="rail-empty" style={{ left: cw - 44, top: mid - 90, width: 44, height: 180 }}>
          <span>Nothing calls it</span>
        </div>
      )}
      {layout.right.length === 0 && (
        <div className="rail-empty" style={{ left: rx, top: mid - 90, width: 44, height: 180 }}>
          <span>Calls nothing</span>
        </div>
      )}
      <div
        className={`node big lit-${node.lamp}`}
        data-center={node.id}
        style={{ left: layout.card.x, top: 0, width: mw, height: layout.h }}
      >
        <div className="n-top">
          <span className={`bdg ${node.roleClass}`}>{node.roleLabel}</span>
          <span className={`st ${st.cls}`}>
            <i className={`lamp ${st.lamp}`} />
            {st.text}
          </span>
        </div>
        <div>
          <div className="n-name">{node.label}</div>
          {node.deploy !== undefined && <div className="path">runs on {node.deploy}</div>}
        </div>
        {node.desc !== "" && <div className="desc">{node.desc}</div>}
        <div className="chips" style={{ margin: 0 }}>
          {chips.map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
          {node.outside.map((c) => (
            <span key={c} className="chip out">
              {c}
            </span>
          ))}
        </div>
        <ProjectInside node={node} />
        <div className="tally">
          <div className="glabel">Links by proof</div>
          {(["code", "answer", "check"] as const).map((t) => (
            <div key={t} className={`tl ${tally(t) > 0 ? "" : "zero"}`}>
              <span className={`bdg ${TIER_LABEL[t].tone}`}>{TIER_LABEL[t].text}</span>
              <b className="mono">{tally(t)}</b>
            </div>
          ))}
        </div>
        <div className="stats">
          <div>
            <b>{graph.ins(node.id).length}</b>
            <span>Used by</span>
          </div>
          <div>
            <b>{graph.outs(node.id).length}</b>
            <span>Talks to</span>
          </div>
          <div>
            <b>{node.tasks.length}</b>
            <span>Open tasks</span>
          </div>
        </div>
      </div>
      <Overlay edges={edges} routes={layout.routes} w={layout.w} h={layout.h} focus={focus} numbered={[]} />
    </>
  );
}
export { BoxChips };
