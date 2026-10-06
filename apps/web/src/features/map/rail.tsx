import type { JourneyView } from "@majhi/shared";
import { Li, RoleBadge, RoleIcon, TriggerIcon } from "./brand";
import { Ic } from "./icons";
import type { Graph, PNode } from "./model";
import type { UiState } from "./use-map-state";

const checks = (j: JourneyView) => j.steps.filter((s) => s.check).length;

/** Where a journey goes, in words: its project and what it reaches, or the projects in order. Shown as a tooltip only. */
export function journeyPath(j: JourneyView): string {
  if (j.inner !== undefined) {
    const outside = [...new Set(j.steps.flatMap((s) => (s.toKind === "outside" ? [s.to] : [])))];
    return `${j.inner.project} only${outside.length > 0 ? ` · ${outside.join(", ")}` : ""}`;
  }
  const order: string[] = [];
  for (const s of j.steps) for (const p of [s.from, s.to]) if (!order.includes(p)) order.push(p);
  return order.join(" → ");
}

/** The left list: projects (connected, then not connected), or journeys in groups by project. */
export function Rail({
  graph,
  journeys,
  s,
  onQuery,
  onRow,
  onJourney,
  onNewJourney,
  onAddLink,
  onMode,
  onToggleGroup,
  onAllGroups,
}: {
  graph: Graph;
  journeys: readonly JourneyView[];
  s: UiState;
  onQuery: (q: string) => void;
  onRow: (id: string) => void;
  onJourney: (id: string) => void;
  onNewJourney: () => void;
  onAddLink: () => void;
  onMode: (m: "start" | "touch") => void;
  onToggleGroup: (id: string) => void;
  onAllGroups: (ids: readonly string[], collapse: boolean) => void;
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
          <RoleBadge label={n.roleLabel} cls={n.roleClass} small />
          <span className={`st ${n.lamp !== "idle" ? n.lamp : ""}`}>{n.lampWord}</span>
        </div>
      </button>
    );
  };
  const con = graph.connected.filter((n) => match(n.label));
  const un = graph.unlinked.filter((n) => match(n.label));

  const shown = journeys.filter((j) => match(`${j.name} ${journeyPath(j)}`));
  const groups = graph.nodes
    .map((n) => ({
      node: n,
      list: shown.filter((j) =>
        s.jmode === "start"
          ? j.start === n.id
          : j.inner === undefined
            ? j.touches.includes(n.id)
            : j.start === n.id,
      ),
    }))
    .filter((g) => g.list.length > 0);
  const ids = groups.map((g) => g.node.id);
  const allOpen = ids.every((id) => s.collapsed[id] !== true);

  const journeyRow = (j: JourneyView) => {
    const chk = checks(j);
    const yours = j.status === "kept";
    return (
      <button
        key={j.id}
        type="button"
        className={`row jc ${yours ? "yours" : ""} ${s.journey === j.id ? "on" : ""}`}
        data-journey={j.id}
        title={journeyPath(j)}
        onClick={() => onJourney(j.id)}
      >
        <div className="l1">
          <span className="nm">{j.name}</span>
          <span className="mk" title={yours ? "Yours" : "Suggested"}>
            <Li n={yours ? "user" : "spark"} />
          </span>
        </div>
        <div className="l2">
          <span className="st" title={j.trigger}>
            <TriggerIcon kind={j.trigger} />
            {j.steps.length} steps
          </span>
          {chk > 0 && (
            <span className="st needs">
              <i className="lamp needs" style={{ width: 6, height: 6 }} />
              {chk} to check
            </span>
          )}
        </div>
      </button>
    );
  };

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
        {journeysView && (
          <>
            <fieldset className="seg rail-seg" aria-label="Group by">
              <button type="button" aria-pressed={s.jmode === "start"} onClick={() => onMode("start")}>
                Start
              </button>
              <button type="button" aria-pressed={s.jmode === "touch"} onClick={() => onMode("touch")}>
                Touches
              </button>
            </fieldset>
            <div className="railctl">
              <span className="glabel">{shown.length} journeys</span>
              <button type="button" onClick={() => onAllGroups(ids, allOpen)}>
                <Li n={allOpen ? "fold" : "expand"} />
                {allOpen ? "Collapse all" : "Expand all"}
              </button>
            </div>
          </>
        )}
      </div>
      <div className="scroll fade">
        <div className="rail-list">
          {journeysView ? (
            groups.length === 0 ? (
              <p className="sub" style={{ padding: "12px 8px" }}>
                {journeys.length === 0
                  ? "No journeys yet. Name one from the lines you found."
                  : "No journeys match."}
              </p>
            ) : (
              groups.map((g) => {
                const open = s.collapsed[g.node.id] !== true;
                return (
                  <div key={g.node.id} style={{ display: "contents" }}>
                    <button
                      type="button"
                      className={`gh jg ${open ? "open" : ""}`}
                      data-gtoggle={g.node.id}
                      aria-expanded={open}
                      onClick={() => onToggleGroup(g.node.id)}
                    >
                      <span className="chv">
                        <Li n="chev" />
                      </span>
                      <span className="rb">
                        <RoleIcon of={g.node.roleLabel} />
                      </span>
                      <span className="pn">{g.node.label}</span>
                      <span className="n">{g.list.length}</span>
                    </button>
                    {open && g.list.map(journeyRow)}
                  </div>
                );
              })
            )
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
