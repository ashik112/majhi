import { type InsideEntry, type JourneyStep, type JourneyView, type OrgView, PRIVATE } from "@majhi/shared";
import { Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Problem } from "@/components/problem";
import { useNewTask } from "@/features/new-task/new-task-context";
import { resolvedTheme, setAppearance } from "@/lib/appearance";
import { describeError } from "@/lib/errors";
import { useInside, useMap, useMapEstimate, useReadInside, useUpdateMap } from "@/lib/map-queries";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";
import { AddressDialog } from "./address-dialog";
import { Chrome } from "./chrome";
import { Detail, type DetailActs } from "./detail";
import { Ic } from "./icons";
import { InsideWorld } from "./inside-world";
import { JourneyWorld } from "./journey-world";
import {
  layoutInside,
  layoutJourney,
  layoutOverview,
  layoutProject,
  type OverviewLayout,
  overviewKey,
} from "./layout";
import { agoWords, buildGraph, CANVAS_ENTRIES, focusInside, usdWords } from "./model";
import { OverviewWorld } from "./overview-world";
import { ProjectWorld } from "./project-world";
import { Rail } from "./rail";
import { Stage, type StageHandle } from "./stage";
import { useMapState, type ViewId } from "./use-map-state";
import "./map.css";

const LAST_KEY = "majhi.map.workspace";

function readLast(): string | undefined {
  try {
    return localStorage.getItem(LAST_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberLast(org: string): void {
  try {
    localStorage.setItem(LAST_KEY, org);
  } catch {
    // Storage blocked: the page opens on the first workspace next time.
  }
}

/**
 * The Map page. It always shows one workspace: the one picked on this page, else the sidebar's, else
 * the one last shown here, else the first. Its picker is the page's own and leaves the sidebar alone.
 */
export function MapScreen() {
  const { org: picked } = useOrgFilter();
  const orgs = useOrgs().data;
  const [chosen, setChosen] = useState<string | undefined>();
  const [seen, setSeen] = useState(picked);
  if (seen !== picked) {
    setSeen(picked);
    setChosen(undefined);
  }
  if (orgs === undefined) {
    return (
      <div className="mapx">
        <header className="top glass">
          <h1>Map</h1>
        </header>
      </div>
    );
  }
  const known = (id: string | undefined) => id !== undefined && orgs.some((o) => o.id === id);
  const org = [chosen, picked, readLast()].find((id): id is string => known(id)) ?? orgs[0]?.id ?? PRIVATE;
  const choose = (id: string) => {
    rememberLast(id);
    setChosen(id);
  };
  return (
    <MapFor
      key={org}
      org={org}
      name={orgs.find((o) => o.id === org)?.name ?? org}
      orgs={orgs}
      onOrg={choose}
    />
  );
}

const VIEWS: readonly { id: ViewId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "project", label: "Project" },
  { id: "journeys", label: "Journeys" },
];

function MapFor({
  org,
  name,
  orgs,
  onOrg,
}: {
  org: string;
  name: string;
  orgs: readonly OrgView[];
  onOrg: (org: string) => void;
}) {
  const map = useMap(org);
  const estimate = useMapEstimate(org);
  const update = useUpdateMap(org);
  const newTask = useNewTask();
  const now = useNow(30_000);
  const data = map.data;
  const graph = useMemo(() => (data === undefined ? undefined : buildGraph(data)), [data]);
  const journeys = useMemo<readonly JourneyView[]>(() => data?.journeys ?? [], [data]);
  const emptyGraph = useMemo(() => buildGraph({ ...EMPTY_VIEW, org }), [org]);
  const g = graph ?? emptyGraph;
  const { s, patch, act, togglePlay } = useMapState(org, g, journeys);
  const stage = useRef<StageHandle>(null);
  const [addresses, setAddresses] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // The Overview's layout runs when the structure of the map changes, never for a hover or a pick.
  const key = overviewKey(g);
  const [ov, setOv] = useState<{ key: string; layout: OverviewLayout }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the structure of `g`
  useEffect(() => {
    if (g.connected.length === 0) return;
    let alive = true;
    void layoutOverview(g).then((layout) => alive && setOv({ key, layout }));
    return () => {
      alive = false;
    };
  }, [key]);
  const overview = ov?.key === key ? ov.layout : undefined;

  const projectNode = s.focus === null ? undefined : g.byId.get(s.focus);
  const projectLayout = useMemo(
    () => (projectNode === undefined ? undefined : layoutProject(g, projectNode.id)),
    [g, projectNode],
  );
  // What is inside the project on show, read when its Inside tab is open.
  const insideFor = s.view === "project" && s.tab === "inside" ? s.focus : null;
  const insideQuery = useInside(org, insideFor);
  const inside = insideFor === null ? undefined : insideQuery.data;
  const spec = inside?.spec;
  const [allEntries, setAllEntries] = useState(false);
  // A new project starts with the few top entry points again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset exactly when the project on show changes
  useEffect(() => setAllEntries(false), [s.focus]);
  const entryId =
    spec === undefined
      ? null
      : s.entry === undefined
        ? (spec.entries
            .slice(0, CANVAS_ENTRIES)
            .reduce<InsideEntry | undefined>(
              (best, e) => (best === undefined || e.steps.length > best.steps.length ? e : best),
              undefined,
            )?.id ?? null)
        : s.entry;
  const focused = useMemo(
    () => (spec === undefined ? undefined : focusInside(spec, entryId, allEntries)),
    [spec, entryId, allEntries],
  );
  const insideLayout = useMemo(
    () => (focused === undefined ? undefined : layoutInside(focused.spec, s.more)),
    [focused, s.more],
  );
  const projectLabels = useMemo(() => new Map(g.nodes.map((n) => [n.label, n.id])), [g]);
  const readInside = useReadInside(org);
  const journey = journeys.find((j) => j.id === s.journey);
  const journeyLayout = useMemo(
    () => (journey === undefined ? undefined : layoutJourney(journey.steps)),
    [journey],
  );

  const detailActs: DetailActs = {
    setDir: act.setDir,
    selectEdge: act.selectEdge,
    openProject: act.openProject,
    openInside: act.openInside,
    pickEntry: act.pickEntry,
    pickInside: act.pickInside,
    pickInsideStep: act.pickInsideStep,
    clearAll: act.clearAll,
    setView: act.setView,
    stepGo: act.stepGo,
    showOnMap: act.showOnMap,
    pickJourney: act.pickJourney,
    pickNode: act.pickNode,
    newTask: (project) => newTask.openFor(project),
    edit: (j) => {
      act.setView("overview");
      patch({
        compose: {
          id: j.id,
          name: j.name,
          steps: j.steps.map(({ check: _check, ...step }): JourneyStep => step),
        },
        trace: null,
      });
    },
    setCompose: (compose) => patch({ compose }),
    saved: (id) => {
      patch({ compose: null, trace: null });
      act.setView("journeys");
      if (id !== undefined) act.pickJourney(id);
    },
  };

  // Keys: / search, 1 2 3 views, Esc clear, F fit, L list, arrows through a journey, Enter opens the picked box.
  const keys = useRef({ s, act, listOpen });
  keys.current = { s, act, listOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { s: cur, act: a, listOpen: open } = keys.current;
      const el = e.target as HTMLElement;
      const typing = el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA";
      if (document.querySelector("dialog[open]") !== null) return;
      if (e.key === "Escape") {
        if (typing) el.blur();
        if (open) setListOpen(false);
        else a.clearAll();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        setListOpen(true);
        requestAnimationFrame(() => document.getElementById("map-q")?.focus());
      } else if (e.key === "1") a.setView("overview");
      else if (e.key === "2") a.setView("project");
      else if (e.key === "3") a.setView("journeys");
      else if (e.key === "f" || e.key === "F") stage.current?.fit();
      else if (e.key === "i" || e.key === "I") a.toggleTab();
      else if (e.key === "t" || e.key === "T") {
        setAppearance({
          theme:
            resolvedTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark") === "light"
              ? "dark"
              : "light",
        });
      } else if (e.key === "l" || e.key === "L") setListOpen((v) => !v);
      else if (e.key === "ArrowRight" && cur.view === "journeys")
        a.stepGo(cur.step === null ? 0 : cur.step + 1);
      else if (e.key === "ArrowLeft" && cur.view === "journeys")
        a.stepGo((cur.step === null ? 1 : cur.step) - 1);
      else if (
        e.key === "Enter" &&
        cur.view === "overview" &&
        cur.sel?.t === "node" &&
        el.closest("[data-node]") === null
      ) {
        a.openProject(cur.sel.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const usd = estimate.data?.usd;
  const ago = data?.updatedAt === undefined ? undefined : agoWords(data.updatedAt, now);
  const failed = data?.failed ?? (update.error === null ? undefined : update.error.message);
  const running = data?.running;

  if (map.isError && data === undefined) {
    return (
      <div className="mapx">
        <header className="top glass">
          <h1>Map</h1>
        </header>
        <Problem icon={<Waypoints />} title="Could not load the map" body={describeError(map.error)} />
      </div>
    );
  }

  const empty = data !== undefined && data.map.nodes.length === 0;
  const unlinked = g.unlinked;
  const addStep = (edgeId: string) => {
    const e = g.edgeById.get(edgeId);
    if (e === undefined || s.compose === null) return;
    patch({
      compose: {
        ...s.compose,
        steps: [...s.compose.steps, { from: e.from, to: e.to, label: e.label.slice(0, 60), edge: e.id }],
      },
    });
  };

  const stageProps = (() => {
    if (s.view === "overview" && overview !== undefined) {
      return {
        w: overview.w,
        h: overview.h,
        top: 90,
        bottom: unlinked.length > 0 ? 118 : 70,
        maxScale: 1.12,
        minText: { size: 14, min: 12.2 },
        fitKey: `o:${key}`,
      };
    }
    if (s.view === "project" && s.tab === "inside") {
      if (insideLayout !== undefined) {
        return {
          w: insideLayout.w,
          h: insideLayout.h,
          top: 142,
          bottom: 70,
          maxScale: 1.12,
          fitKey: `in:${s.focus}:${s.more}:${entryId}:${allEntries}`,
        };
      }
      return { w: 360, h: 150, top: 142, bottom: 70, maxScale: 1.12, fitKey: `in0:${s.focus}` };
    }
    if (s.view === "project" && projectLayout !== undefined) {
      return {
        w: projectLayout.w,
        h: projectLayout.h,
        top: 134,
        bottom: 70,
        maxScale: 1.12,
        fitKey: `p:${s.focus}`,
      };
    }
    if (s.view === "journeys" && journeyLayout !== undefined) {
      return {
        w: journeyLayout.w,
        h: journeyLayout.h,
        top: 64,
        bottom: 70,
        maxScale: 1,
        fitKey: `j:${s.journey}`,
      };
    }
    return undefined;
  })();

  return (
    <div ref={root} className={`mapx ${listOpen ? "list-open" : ""}`} data-view={s.view}>
      <header className="top glass">
        <h1>Map</h1>
        {orgs.length > 1 && (
          <select
            className="field"
            style={{ width: 150, height: 32 }}
            aria-label="Workspace"
            value={org}
            onChange={(e) => onOrg(e.target.value)}
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        )}
        <fieldset className="seg" aria-label="View">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={s.view === v.id}
              data-view={v.id}
              onClick={() => act.setView(v.id)}
            >
              {v.label}
              {v.id === "journeys" && <span className="c">{journeys.length}</span>}
            </button>
          ))}
        </fieldset>
        <span className="vsep" />
        <div className="tele">
          <div>
            <b>{g.totals.projects}</b>projects
          </div>
          <div>
            <b>{g.totals.links}</b>links
          </div>
          <div className={g.totals.check > 0 ? "lit" : ""}>
            <b>{g.totals.check}</b>to check
          </div>
          <div className="opt">
            <b>{g.totals.notConnected}</b>not connected
          </div>
        </div>
        <div className="right">
          <span className="upd" data-map-fresh="">
            {ago === undefined ? `${name}: never updated` : `Updated ${ago}`}
            {data !== undefined &&
              ago !== undefined &&
              data.mergesSince > 0 &&
              ` · ${data.mergesSince} ${data.mergesSince === 1 ? "merge" : "merges"} since`}
          </span>
          <button
            type="button"
            className="btn pri update-btn"
            data-act="update"
            disabled={running !== undefined || update.isPending || data === undefined}
            title={estimate.data?.note}
            onClick={() => update.mutate("")}
          >
            <Ic n="refresh" />
            Update map
            {usd !== undefined && (
              <span className="cost" style={{ fontWeight: 400, opacity: 0.75 }}>
                {usdWords(usd)}
              </span>
            )}
          </button>
        </div>
      </header>
      <div className="work">
        <section className="panel glass rail" aria-label="Projects">
          {data !== undefined && (
            <Rail
              graph={g}
              journeys={journeys}
              s={s}
              onQuery={(q) => patch({ q })}
              onRow={(id) => {
                if (s.view === "project") act.openProject(id);
                else if (g.byId.get(id)?.connected !== true) act.openInside(id);
                else {
                  if (s.view === "journeys") act.setView("overview");
                  act.pickNode(id);
                }
              }}
              onJourney={(id) => {
                act.pickJourney(id);
              }}
              onNewJourney={() => {
                act.setView("overview");
                patch({ compose: { name: "", steps: [] }, sel: null, trace: null });
              }}
              onAddLink={() => setAddresses(true)}
              onMode={act.setJmode}
              onToggleGroup={act.toggleGroup}
              onAllGroups={act.setGroups}
            />
          )}
        </section>
        <section className="canvas glass" aria-label="Map">
          {empty ? (
            <div className="empty">
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  maxWidth: 420,
                  alignItems: "flex-start",
                }}
              >
                <h2 style={{ fontSize: 15, fontWeight: 600 }}>No map yet</h2>
                <p style={{ color: "var(--fg-muted)" }}>
                  {data.projects.length === 0
                    ? `${name} has no projects on this computer. Register one on Projects and links, then update the map.`
                    : `Update the map to read the ${data.projects.length} ${data.projects.length === 1 ? "project" : "projects"} of ${name} and draw how they connect.`}
                </p>
                {data.projects.length > 0 && (
                  <button
                    type="button"
                    className="btn pri update-btn"
                    disabled={running !== undefined}
                    onClick={() => update.mutate("")}
                  >
                    Update map
                  </button>
                )}
              </div>
            </div>
          ) : data === undefined || stageProps === undefined ? (
            <div role="status" aria-busy="true" className="empty" style={{ color: "var(--fg-faint)" }}>
              {data === undefined
                ? "Reading the map"
                : s.view === "overview" && g.connected.length === 0
                  ? "No project is linked yet. Pick one in the list to see it."
                  : "Drawing"}
            </div>
          ) : (
            <Stage ref={stage} {...stageProps} onBackground={act.clearAll}>
              {s.view === "overview" && overview !== undefined && (
                <OverviewWorld graph={g} layout={overview} s={s} acts={{ ...act, addStep }} />
              )}
              {s.view === "project" &&
                s.tab === "conn" &&
                projectNode !== undefined &&
                projectLayout !== undefined && (
                  <ProjectWorld graph={g} node={projectNode} layout={projectLayout} s={s} acts={act} />
                )}
              {s.view === "project" &&
                s.tab === "inside" &&
                focused !== undefined &&
                insideLayout !== undefined && (
                  <InsideWorld
                    spec={focused.spec}
                    hidden={focused.hidden}
                    allEntries={allEntries}
                    onMoreEntries={() => setAllEntries(!allEntries)}
                    layout={insideLayout}
                    s={s}
                    entryId={entryId}
                    acts={act}
                    projectIds={projectLabels}
                  />
                )}
              {s.view === "project" &&
                s.tab === "inside" &&
                spec === undefined &&
                projectNode !== undefined && (
                  <div
                    className="node big"
                    style={{ left: 0, top: 0, width: 360, height: 150 }}
                    data-unread={projectNode.id}
                  >
                    <div className="n-name">
                      {inside === undefined ? "Looking inside" : "Not read inside yet"}
                    </div>
                    <div className="desc">
                      {inside === undefined
                        ? "Reading what majhi already knows."
                        : `majhi has not read the code of ${projectNode.label}. Read it to see its entry points, steps and data.`}
                    </div>
                    <div>
                      <button
                        type="button"
                        className="btn sec sm"
                        disabled={
                          inside === undefined || readInside.isPending || projectNode.project === undefined
                        }
                        onClick={() =>
                          projectNode.project !== undefined && readInside.mutate(projectNode.project)
                        }
                      >
                        Read inside
                      </button>
                    </div>
                  </div>
                )}
              {s.view === "journeys" && journey !== undefined && journeyLayout !== undefined && (
                <JourneyWorld
                  graph={g}
                  journey={journey}
                  layout={journeyLayout}
                  step={s.step}
                  play={s.play}
                  onStep={act.stepGo}
                />
              )}
            </Stage>
          )}
          {data !== undefined && !empty && (
            <Chrome
              graph={g}
              s={s}
              journey={journey}
              unlinked={unlinked}
              onCrumb={act.crumb}
              onView={act.setView}
              onClear={act.clearAll}
              onFit={() => stage.current?.fit()}
              onZoom={(f) => stage.current?.zoom(f)}
              onList={() => setListOpen((v) => !v)}
              onPickMini={(id) => act.openInside(id)}
              inside={spec}
              onTab={act.setTab}
              onMore={act.toggleMore}
              onPlay={togglePlay}
              onStep={act.stepGo}
              onJourneys={() => act.setView("journeys")}
              onComposeName={(n) => s.compose !== null && patch({ compose: { ...s.compose, name: n } })}
            />
          )}
          {running !== undefined && (
            <div
              role="status"
              className="float"
              style={{
                position: "absolute",
                top: 12,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 20,
                padding: "6px 12px",
                fontSize: 13,
              }}
            >
              {running.text}
            </div>
          )}
          {failed !== undefined ? (
            <p
              role="alert"
              className="float"
              style={{
                position: "absolute",
                top: 12,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 20,
                padding: "6px 12px",
                fontSize: 13,
                color: "var(--c-red)",
                maxWidth: 420,
              }}
            >
              {failed}
            </p>
          ) : (
            data?.report?.note !== undefined &&
            s.view === "overview" &&
            running === undefined && (
              <p
                className="float"
                style={{
                  position: "absolute",
                  top: 56,
                  left: "50%",
                  transform: "translateX(-50%)",
                  zIndex: 5,
                  padding: "6px 12px",
                  fontSize: 12,
                  color: "var(--fg-muted)",
                  maxWidth: 420,
                }}
              >
                {data.report.note}
              </p>
            )
          )}
        </section>
        <section className="panel glass" aria-label="Map details">
          {data !== undefined && graph !== undefined && !empty && (
            <Detail
              view={data}
              graph={graph}
              journeys={journeys}
              s={s}
              acts={detailActs}
              inside={insideFor === null ? undefined : inside}
              entryId={entryId}
            />
          )}
        </section>
      </div>
      {addresses && data !== undefined && <AddressDialog view={data} onClose={() => setAddresses(false)} />}
    </div>
  );
}

const EMPTY_VIEW = {
  org: "",
  map: { v: 1 as const, nodes: [], edges: [], removed: [], endpoints: [], resolutions: [], roles: [] },
  mergesSince: 0,
  tasks: [],
  changedThisWeek: [],
  projects: [],
  journeys: [],
};
