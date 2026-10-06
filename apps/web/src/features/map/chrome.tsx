import type { JourneyView } from "@majhi/shared";
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
        ) : (
          <>
            <div className="legend glass">
              <span>{dash({})}Call</span>
              <span>{dash({ dash: "6 5" })}Job</span>
              <span>{dash({ dash: "1.5 5", w: 2, cap: true })}Embed</span>
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
