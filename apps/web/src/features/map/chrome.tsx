import type { InsideSpec, JourneyView } from "@majhi/shared";
import { Li } from "./brand";
import { Ic } from "./icons";
import type { Graph, PNode } from "./model";
import type { UiState, ViewId } from "./use-map-state";

const LINE = "rgb(150 195 245 / .6)";

/** Everything laid over the canvas: breadcrumb, trace chip, zoom, the not-connected strip, legend, hints, player. */
export function Chrome({
  graph,
  s,
  journey,
  unlinked,
  onCrumb,
  onView,
  onClear,
  onFit,
  onZoom,
  onList,
  onPickMini,
  onPlay,
  onStep,
  onJourneys,
  onComposeName,
  inside,
  onTab,
  onMore,
}: {
  graph: Graph;
  s: UiState;
  journey: JourneyView | undefined;
  unlinked: readonly PNode[];
  onCrumb: (i: number) => void;
  onView: (v: ViewId) => void;
  onClear: () => void;
  onFit: () => void;
  onZoom: (factor: number) => void;
  onList: () => void;
  onPickMini: (id: string) => void;
  onPlay: () => void;
  onStep: (i: number) => void;
  onJourneys: () => void;
  onComposeName: (name: string) => void;
  /** The Inside spec of the project on show, when it has been read. */
  inside: InsideSpec | undefined;
  onTab: (tab: "conn" | "inside") => void;
  onMore: () => void;
}) {
  const q = s.q.trim().toLowerCase();
  const sep = (
    <span key="sep" className="sep">
      <Ic n="chev" />
    </span>
  );
  const crumbs = (() => {
    if (s.view === "overview") return <span className="cur">Overview</span>;
    if (s.view === "project") {
      const parts: React.ReactNode[] = [
        <button key="o" type="button" onClick={() => onView("overview")}>
          Overview
        </button>,
      ];
      s.trail.forEach((id, i) => {
        parts.push(sep);
        const label = graph.byId.get(id)?.label ?? id;
        parts.push(
          i === s.trail.length - 1 ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same project can be visited twice
            <span key={`${id}:${i}`} className="cur">
              {label}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same project can be visited twice
            <button key={`${id}:${i}`} type="button" onClick={() => onCrumb(i)}>
              {label}
            </button>
          ),
        );
      });
      return parts;
    }
    return [
      <button key="j" type="button" onClick={onJourneys}>
        Journeys
      </button>,
      sep,
      <span key="n" className="cur">
        {journey?.name ?? "None"}
      </span>,
    ];
  })();
  const dash = (extra: { dash?: string; w?: number; color?: string; cap?: boolean }) => (
    <svg viewBox="0 0 26 8" aria-hidden="true">
      <path
        d="M1 4H25"
        stroke={extra.color ?? LINE}
        strokeWidth={extra.w ?? 1.5}
        strokeDasharray={extra.dash}
        strokeLinecap={extra.cap === true ? "round" : undefined}
        fill="none"
      />
    </svg>
  );
  const n = journey?.steps.length ?? 0;
  const cur = s.step === null ? 0 : s.step + 1;
  return (
    <>
      <div className="tb tl">
        <div className="crumbs float">{crumbs}</div>
        {s.view === "project" && s.focus !== null && (
          <div className="tabsrow">
            <fieldset className="seg tabs" aria-label="Project tab">
              <button
                type="button"
                aria-pressed={s.tab === "conn"}
                data-tab="conn"
                onClick={() => onTab("conn")}
              >
                Connections{" "}
                <span className="c">
                  {(graph.byId.get(s.focus)?.ins ?? 0) + (graph.byId.get(s.focus)?.outs ?? 0)}
                </span>
              </button>
              <button
                type="button"
                aria-pressed={s.tab === "inside"}
                data-tab="inside"
                onClick={() => onTab("inside")}
              >
                Inside{inside === undefined ? null : <span className="c"> {inside.fns.length}</span>}
              </button>
            </fieldset>
            {s.tab === "inside" && inside !== undefined && (
              <button
                type="button"
                className="btn sec sm"
                data-act="more"
                style={{ height: 32, background: "var(--glass-strong)" }}
                onClick={onMore}
              >
                <Li n="layers" />
                {s.more ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}
        {s.view === "project" && s.tab === "inside" && s.focus !== null && inside !== undefined && (
          <div style={{ flexBasis: "100%" }}>
            <div className="strip float" style={{ display: "inline-flex", maxWidth: "100%" }}>
              {(graph.byId.get(s.focus)?.connected ?? false) ? (
                <span className="bdg blue">
                  <Li n="route" />
                  Linked · {graph.byId.get(s.focus)?.ins ?? 0} in {graph.byId.get(s.focus)?.outs ?? 0} out
                </span>
              ) : (
                <span className="bdg green">
                  <Li n="check" />
                  Self-contained
                </span>
              )}
              <span className="cnt">
                <b>{Object.values(inside.totals).reduce((a, n) => a + n, 0)}</b>entry points
              </span>
              <span className="cnt">
                <b>{inside.services.length}</b>services
              </span>
              <span className="cnt">
                <b>{inside.fns.length}</b>steps
              </span>
              <span className="cnt">
                <b>{inside.data.filter((x) => x.kind === "out").length}</b>outside
              </span>
              <span className="cnt">
                <b>{inside.dbs.length}</b>
                {inside.dbs.length === 1 ? "database" : "databases"}
              </span>
            </div>
          </div>
        )}
        {s.view === "overview" && s.compose !== null && (
          <div className="tracechip float">
            <span className="num">{s.compose.steps.length}</span>
            <span>
              <b>{s.compose.id === undefined ? "Naming a journey" : "Editing a journey"}</b> · click the lines
              in order
            </span>
            <input
              aria-label="Journey name"
              placeholder="Name"
              value={s.compose.name}
              maxLength={60}
              onChange={(e) => onComposeName(e.target.value)}
            />
            <button type="button" className="x" title="Cancel (Esc)" aria-label="Cancel" onClick={onClear}>
              <Ic n="x" />
            </button>
          </div>
        )}
        {s.view === "overview" && s.compose === null && s.trace !== null && (
          <div className="tracechip float">
            <span className="num">{s.trace.edges.length}</span>
            <span>
              <b>{s.trace.title}</b> · {s.trace.edges.length} steps
            </span>
            <button
              type="button"
              className="x"
              title="Clear (Esc)"
              aria-label="Clear trace"
              onClick={onClear}
            >
              <Ic n="x" />
            </button>
          </div>
        )}
      </div>
      <div className="tb tr">
        <button
          type="button"
          className="ibtn only-narrow"
          title="List (L)"
          aria-label="List"
          onClick={onList}
        >
          <Ic n="list" />
        </button>
        <div className="zoom">
          <button
            type="button"
            className="ibtn"
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => onZoom(1.2)}
          >
            <Ic n="plus" />
          </button>
          <button
            type="button"
            className="ibtn"
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => onZoom(1 / 1.2)}
          >
            <Ic n="minus" />
          </button>
          <button type="button" className="ibtn" title="Fit (F)" aria-label="Fit" onClick={onFit}>
            <Ic n="fit" />
          </button>
        </div>
      </div>
      {s.view === "overview" && unlinked.length > 0 && (
        <div className="dock glass">
          <span className="glabel">Not connected</span>
          <div className="nodes">
            {unlinked.map((u) => (
              <button
                key={u.id}
                type="button"
                className={`mini ${s.sel?.t === "node" && s.sel.id === u.id ? "on" : ""} ${q === "" || u.label.toLowerCase().includes(q) ? "" : "dim"}`}
                data-row={u.id}
                title="Pick it. Press Enter to open its project."
                onClick={() => onPickMini(u.id)}
              >
                <i className="lamp idle" />
                {u.label}
              </button>
            ))}
          </div>
          <span className="sub" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
            no links found
          </span>
        </div>
      )}
      <div className="btm">
        {s.view === "journeys" ? (
          <>
            <div className="legend glass">
              <span>{dash({ color: "var(--blue)", w: 2 })}Step</span>
              <span>{dash({ color: "var(--caution)", w: 1.6 })}Needs a check</span>
            </div>
            <div className="player float">
              <button
                type="button"
                className="ibtn"
                title="Back (←)"
                aria-label="Back"
                onClick={() => onStep((s.step === null ? 1 : s.step) - 1)}
              >
                <Ic n="back" />
              </button>
              <span className="p">{cur > 0 ? `Step ${cur} of ${n}` : `${n} steps`}</span>
              <button
                type="button"
                className="ibtn"
                title="Next (→)"
                aria-label="Next"
                onClick={() => onStep(s.step === null ? 0 : s.step + 1)}
              >
                <Ic n="fwd" />
              </button>
              <button type="button" className="btn sm sec" style={{ marginLeft: 2 }} onClick={onPlay}>
                <Ic n={s.play ? "pause" : "play"} />
                {s.play ? "Pause" : "Play"}
              </button>
            </div>
          </>
        ) : s.view === "project" && s.tab === "inside" ? (
          <>
            <div className="legend glass">
              <span>
                {dash({ color: "var(--blue)", w: 2 })}
                <Li n="route" />
                Step
              </span>
              <span>
                {dash({ color: "var(--blue)", w: 2, dash: "6 5" })}
                <Li n="database" />
                Data
              </span>
              <span>
                <span className="chip out" style={{ height: 18, padding: "0 5px" }}>
                  <Li n="globe" />
                </span>
                Outside
              </span>
            </div>
            <div className="hints glass">
              <span>
                <kbd>Esc</kbd>Clear
              </span>
              <span>
                <kbd>F</kbd>Fit
              </span>
              <span>
                <kbd>I</kbd>Tab
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="legend glass">
              <span>
                {dash({})}
                <Li n="route" />
                Call
              </span>
              <span>
                {dash({ dash: "6 5" })}
                <Li n="list" />
                Job
              </span>
              <span>
                {dash({ dash: "1.5 5", w: 2, cap: true })}
                <Li n="app" />
                Embed
              </span>
              <span>{dash({ color: "var(--caution)" })}Check</span>
            </div>
            <div className="hints glass">
              <span>
                <kbd>/</kbd>Search
              </span>
              <span>
                <kbd>Esc</kbd>Clear
              </span>
              <span>
                <kbd>F</kbd>Fit
              </span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
