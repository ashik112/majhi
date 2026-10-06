import type { JourneyView } from "@majhi/shared";
import { Ic } from "./icons";
import type { Graph, PNode } from "./model";
import type { UiState } from "./use-map-state";

const checks = (j: JourneyView) => j.steps.filter((s) => s.check).length;

/** The left list: projects (connected, then not connected) or journeys, with search and one action below. */
export function Rail({
  graph,
  journeys,
  s,
  onQuery,
  onRow,
  onJourney,
  onNewJourney,
  onAddLink,
}: {
  graph: Graph;
  journeys: readonly JourneyView[];
  s: UiState;
  onQuery: (q: string) => void;
  onRow: (id: string) => void;
  onJourney: (id: string) => void;
  onNewJourney: () => void;
  onAddLink: () => void;
}) {
  const q = s.q.trim().toLowerCase();
  const match = (text: string) => q === "" || text.toLowerCase().includes(q);
  const journeysView = s.view === "journeys";
  const row = (n: PNode) => {
    const on = (s.view === "project" ? s.focus : s.sel?.t === "node" ? s.sel.id : null) === n.id;
    return (
      <button
        key={n.id}
        type="button"
        className={`row ${on ? "on" : ""} ${n.connected ? "" : "unlinked"}`}
        data-row={n.id}
        onClick={() => onRow(n.id)}
      >
        <div className="l1">
          <i className={`lamp ${n.lamp}`} />
          <span className="nm">{n.label}</span>
          <span className="io" title={`${n.ins} in, ${n.outs} out`}>
            ←{n.ins} →{n.outs}
          </span>
        </div>
        <div className="l2">
          <span className={`bdg ${n.roleClass}`} style={{ height: 18 }}>
            {n.roleLabel}
          </span>
          <span className={`st ${n.lamp !== "idle" ? n.lamp : ""}`}>{n.lampWord}</span>
        </div>
      </button>
    );
  };
  const con = graph.connected.filter((n) => match(n.label));
  const un = graph.unlinked.filter((n) => match(n.label));
  return (
    <>
      <div className="rail-head">
        <div className="search">
          <Ic n="search" />
          <input
            id="map-q"
            placeholder={journeysView ? "Search journeys" : "Find a project"}
            aria-label={journeysView ? "Search journeys" : "Find a project"}
            value={s.q}
            autoComplete="off"
            onChange={(e) => onQuery(e.target.value)}
          />
          <kbd>/</kbd>
        </div>
      </div>
      <div className="scroll fade">
        <div className="rail-list">
          {journeysView ? (
            <>
              <div className="gh">
                <span className="glabel">Journeys</span>
                <span className="n">{journeys.length}</span>
              </div>
              {journeys.length === 0 && (
                <p className="sub" style={{ padding: "4px 8px" }}>
                  No journeys yet. Name one from the lines you found.
                </p>
              )}
              {journeys
                .filter((j) => match(j.name))
                .map((j) => {
                  const c = checks(j);
                  return (
                    <button
                      key={j.id}
                      type="button"
                      className={`row ${s.journey === j.id ? "on" : ""}`}
                      data-journey={j.id}
                      onClick={() => onJourney(j.id)}
                    >
                      <div className="l1">
                        <span className="nm">{j.name}</span>
                        {j.status === "example" && (
                          <span className="bdg" style={{ marginLeft: "auto" }}>
                            Example
                          </span>
                        )}
                      </div>
                      <div className="l2">
                        <span className="st">{j.steps.length} steps</span>
                        {c > 0 && (
                          <span className="st needs">
                            <i className="lamp needs" />
                            {c} to check
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
            </>
          ) : (
            <>
              <div className="gh">
                <span className="glabel">Connected</span>
                <span className="n">{con.length}</span>
              </div>
              {con.map(row)}
              {un.length > 0 && (
                <>
                  <div className="gh">
                    <span className="glabel">Not connected</span>
                    <span className="n">{un.length}</span>
                  </div>
                  {un.map(row)}
                </>
              )}
            </>
          )}
        </div>
      </div>
      <div className="rail-foot">
        {journeysView ? (
          <button type="button" className="btn sec sm" onClick={onNewJourney}>
            <Ic n="plus" />
            Name a journey
          </button>
        ) : (
          <button type="button" className="btn sec sm" onClick={onAddLink}>
            <Ic n="plus" />
            Add a link
          </button>
        )}
      </div>
    </>
  );
}
