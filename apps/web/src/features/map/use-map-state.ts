import type { JourneyStep, JourneyView } from "@majhi/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Graph, traceFrom } from "./model";

export type ViewId = "overview" | "project" | "journeys";
export type TabId = "conn" | "inside";
export type Sel = { t: "node"; id: string } | { t: "edge"; id: string } | null;
/** Something picked inside a project: a function or a piece of data. */
export type InsideSel = { t: "fn"; id: string } | { t: "dn"; id: string } | null;

export interface Trace {
  edges: string[];
  title: string;
  /** The box the trace started from; absent for a journey drawn on the map. */
  node: string | null;
}

/** A journey being named: steps picked in order by clicking lines on the Overview. */
export interface Compose {
  /** Set when an existing journey is edited. */
  id?: string;
  name: string;
  steps: JourneyStep[];
}

export interface UiState {
  view: ViewId;
  sel: Sel;
  hover: Sel;
  trace: Trace | null;
  dir: "out" | "in";
  focus: string | null;
  trail: string[];
  /** The project's tab: its connections, or what is inside it. */
  tab: TabId;
  /** The entry point lit on the Inside canvas. Undefined: the first one; null: none. */
  entry: string | null | undefined;
  /** The step of its story that is lit. */
  istep: number | null;
  isel: InsideSel;
  /** Inside: one more level of functions, each with what it does. */
  more: boolean;
  journey: string | null;
  step: number | null;
  play: boolean;
  /** Journeys are grouped by the project they start in, or by every project they touch. */
  jmode: "start" | "touch";
  /** Collapsed journey groups, by project id. */
  collapsed: Record<string, boolean>;
  q: string;
  compose: Compose | null;
}

const START: UiState = {
  view: "overview",
  sel: null,
  hover: null,
  trace: null,
  dir: "out",
  focus: null,
  trail: [],
  tab: "conn",
  entry: undefined,
  istep: null,
  isel: null,
  more: false,
  journey: null,
  step: null,
  play: false,
  jmode: "start",
  collapsed: {},
  q: "",
  compose: null,
};

const sameSel = (a: Sel, b: Sel) => a?.t === b?.t && a?.id === b?.id;

const groupsKey = (org: string) => `majhi.map.journey-groups.${org}`;

/** Which journey groups were collapsed, kept for this browser tab only. */
function readCollapsed(org: string): Record<string, boolean> {
  try {
    const raw = sessionStorage.getItem(groupsKey(org));
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v === true));
  } catch {
    return {};
  }
}

/**
 * The page's state and the moves from the mockup: pick a box to trace it, open it as a project, walk
 * its neighbours, look inside it, step through a journey, show a journey on the map. Everything is plain
 * data; nothing here touches the layout.
 */
export function useMapState(org: string, graph: Graph, journeys: readonly JourneyView[]) {
  const [s, setS] = useState<UiState>(() => ({ ...START, collapsed: readCollapsed(org) }));
  const ref = useRef(s);
  ref.current = s;
  const patch = useCallback((p: Partial<UiState>) => setS((cur) => ({ ...cur, ...p })), []);

  useEffect(() => {
    try {
      sessionStorage.setItem(groupsKey(org), JSON.stringify(s.collapsed));
    } catch {
      // Storage blocked: the groups open again next time.
    }
  }, [org, s.collapsed]);

  const traceOf = useCallback(
    (id: string, dir: "out" | "in"): Trace => ({
      edges: traceFrom(graph, id, dir),
      title: `${dir === "out" ? "From" : "Into"} ${graph.byId.get(id)?.label ?? id}`,
      node: id,
    }),
    [graph],
  );

  const act = useMemo(() => {
    const hasLinks = (id: string) => graph.byId.get(id)?.connected === true;
    const projectReset = { entry: undefined, istep: null, isel: null, sel: null } as const;
    const setView = (v: ViewId) =>
      setS((cur) => {
        const next: UiState = { ...cur, view: v, play: false, hover: null, q: "", compose: null };
        if (v === "project") {
          const pick = cur.sel?.t === "node" && graph.byId.has(cur.sel.id) ? cur.sel.id : undefined;
          const focus = pick ?? cur.focus ?? graph.connected[0]?.id ?? graph.nodes[0]?.id ?? null;
          if (pick !== undefined || cur.focus === null || !cur.trail.includes(focus ?? "")) {
            next.trail = focus === null ? [] : [focus];
          }
          next.focus = focus;
          Object.assign(next, projectReset);
          // A project with no link has nothing on its Connections tab: it opens on Inside.
          if (focus !== null && !hasLinks(focus)) next.tab = "inside";
        }
        if (v === "overview" && cur.view === "project" && cur.focus !== null) {
          next.sel = { t: "node", id: cur.focus };
          next.trace = traceOf(cur.focus, cur.dir);
        }
        if (v === "journeys") {
          next.step = null;
          next.sel = null;
          next.journey =
            cur.journey !== null && journeys.some((j) => j.id === cur.journey)
              ? cur.journey
              : (journeys[0]?.id ?? null);
        }
        return next;
      });
    const pickNode = (id: string) =>
      setS((cur) => ({ ...cur, sel: { t: "node", id }, trace: traceOf(id, cur.dir) }));
    const openProject = (id: string, tab?: TabId) =>
      setS((cur) => ({
        ...cur,
        view: "project",
        focus: id,
        trail: [id],
        ...projectReset,
        tab: tab ?? (hasLinks(id) ? cur.tab : "inside"),
        hover: null,
        q: "",
        play: false,
        compose: null,
      }));
    /** From a journey or a list: the project's Inside tab with an entry point lit. */
    const openInside = (id: string, entry?: string) =>
      setS((cur) => ({
        ...cur,
        view: "project",
        focus: id,
        trail: [id],
        tab: "inside",
        entry,
        istep: null,
        isel: null,
        sel: null,
        hover: null,
        q: "",
        play: false,
        compose: null,
      }));
    const focusProject = (id: string, push = true) =>
      setS((cur) => ({
        ...cur,
        focus: id,
        trail: push ? [...cur.trail, id] : cur.trail,
        ...projectReset,
        tab: hasLinks(id) ? cur.tab : "inside",
        hover: null,
      }));
    const crumb = (i: number) =>
      setS((cur) => {
        const trail = cur.trail.slice(0, i + 1);
        const focus = trail[i] ?? cur.focus;
        return {
          ...cur,
          trail,
          focus,
          ...projectReset,
          tab: focus !== null && !hasLinks(focus) ? "inside" : cur.tab,
          hover: null,
        };
      });
    const clearAll = () =>
      setS((cur) => {
        if (cur.view === "overview") {
          return cur.compose !== null ? { ...cur, compose: null } : { ...cur, sel: null, trace: null };
        }
        if (cur.view === "project") {
          if (cur.tab === "inside") {
            return cur.isel !== null ? { ...cur, isel: null } : { ...cur, entry: null, istep: null };
          }
          return { ...cur, sel: null };
        }
        return { ...cur, step: null, play: false };
      });
    const setHover = (h: Sel) => setS((cur) => (sameSel(cur.hover, h) ? cur : { ...cur, hover: h }));
    const selectEdge = (id: string) => setS((cur) => ({ ...cur, sel: { t: "edge", id } }));
    const setDir = (dir: "out" | "in") =>
      setS((cur) => ({
        ...cur,
        dir,
        trace: cur.sel?.t === "node" ? traceOf(cur.sel.id, dir) : cur.trace,
      }));
    const setTab = (tab: TabId) => setS((cur) => ({ ...cur, tab, isel: null, istep: null }));
    const toggleTab = () =>
      setS((cur) =>
        cur.view === "project"
          ? { ...cur, tab: cur.tab === "inside" ? "conn" : "inside", isel: null, istep: null }
          : cur,
      );
    const pickEntry = (id: string) => setS((cur) => ({ ...cur, entry: id, istep: null, isel: null }));
    const pickInside = (isel: InsideSel) => setS((cur) => ({ ...cur, isel }));
    const pickInsideStep = (i: number | null) => setS((cur) => ({ ...cur, istep: i }));
    const toggleMore = () => setS((cur) => ({ ...cur, more: !cur.more }));
    const stepGo = (i: number) =>
      setS((cur) => {
        const n = journeys.find((j) => j.id === cur.journey)?.steps.length ?? 0;
        return n === 0 ? cur : { ...cur, step: Math.max(0, Math.min(n - 1, i)) };
      });
    const pickJourney = (id: string) =>
      setS((cur) => ({ ...cur, view: "journeys", journey: id, step: null, play: false, sel: null }));
    const setJmode = (jmode: "start" | "touch") => setS((cur) => ({ ...cur, jmode }));
    const toggleGroup = (id: string) =>
      setS((cur) => ({ ...cur, collapsed: { ...cur.collapsed, [id]: cur.collapsed[id] !== true } }));
    const setGroups = (ids: readonly string[], collapse: boolean) =>
      setS((cur) => ({
        ...cur,
        collapsed: { ...cur.collapsed, ...Object.fromEntries(ids.map((id) => [id, collapse])) },
      }));
    const showOnMap = (id: string) =>
      setS((cur) => {
        const j = journeys.find((x) => x.id === id);
        if (j === undefined) return cur;
        const edges = j.steps.flatMap((st) =>
          st.edge !== undefined && graph.edgeById.has(st.edge) ? [st.edge] : [],
        );
        return {
          ...cur,
          view: "overview",
          trace: { edges, title: j.name, node: null },
          sel: null,
          play: false,
          compose: null,
        };
      });
    return {
      setView,
      pickNode,
      openProject,
      openInside,
      focusProject,
      crumb,
      clearAll,
      setHover,
      selectEdge,
      setDir,
      setTab,
      toggleTab,
      pickEntry,
      pickInside,
      pickInsideStep,
      toggleMore,
      stepGo,
      pickJourney,
      setJmode,
      toggleGroup,
      setGroups,
      showOnMap,
    };
  }, [graph, journeys, traceOf]);

  // Play: one step a second and a bit, from the start when nothing is picked, until the last step.
  useEffect(() => {
    if (!s.play) return;
    const t = setInterval(() => {
      const cur = ref.current;
      const n = journeys.find((j) => j.id === cur.journey)?.steps.length ?? 0;
      if (cur.step === null) act.stepGo(0);
      else if (cur.step < n - 1) act.stepGo(cur.step + 1);
      else patch({ play: false });
    }, 1100);
    return () => clearInterval(t);
  }, [s.play, journeys, act, patch]);

  const togglePlay = useCallback(() => {
    const cur = ref.current;
    const n = journeys.find((j) => j.id === cur.journey)?.steps.length ?? 0;
    if (cur.play) return patch({ play: false });
    patch({ play: true, step: cur.step === null || cur.step >= n - 1 ? 0 : cur.step });
  }, [journeys, patch]);

  return { s, patch, act, togglePlay };
}
