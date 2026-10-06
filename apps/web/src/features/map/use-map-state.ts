import type { JourneyStep, JourneyView } from "@majhi/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Graph, traceFrom } from "./model";

export type ViewId = "overview" | "project" | "journeys";
export type Sel = { t: "node"; id: string } | { t: "edge"; id: string } | null;

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
  journey: string | null;
  step: number | null;
  play: boolean;
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
  journey: null,
  step: null,
  play: false,
  q: "",
  compose: null,
};

const sameSel = (a: Sel, b: Sel) => a?.t === b?.t && a?.id === b?.id;

/**
 * The page's state and the moves from the mockup: pick a box to trace it, open it as a project, walk
 * its neighbours, step through a journey, show a journey on the map. Everything is plain data; nothing
 * here touches the layout.
 */
export function useMapState(graph: Graph, journeys: readonly JourneyView[]) {
  const [s, setS] = useState<UiState>(START);
  const ref = useRef(s);
  ref.current = s;
  const patch = useCallback((p: Partial<UiState>) => setS((cur) => ({ ...cur, ...p })), []);

  const traceOf = useCallback(
    (id: string, dir: "out" | "in"): Trace => ({
      edges: traceFrom(graph, id, dir),
      title: `${dir === "out" ? "From" : "Into"} ${graph.byId.get(id)?.label ?? id}`,
      node: id,
    }),
    [graph],
  );

  const act = useMemo(() => {
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
          next.sel = null;
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
    const openProject = (id: string) =>
      setS((cur) => ({
        ...cur,
        view: "project",
        focus: id,
        trail: [id],
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
        sel: null,
        hover: null,
      }));
    const crumb = (i: number) =>
      setS((cur) => {
        const trail = cur.trail.slice(0, i + 1);
        return { ...cur, trail, focus: trail[i] ?? cur.focus, sel: null, hover: null };
      });
    const clearAll = () =>
      setS((cur) => {
        if (cur.view === "overview") {
          return cur.compose !== null ? { ...cur, compose: null } : { ...cur, sel: null, trace: null };
        }
        if (cur.view === "project") return { ...cur, sel: null };
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
    const stepGo = (i: number) =>
      setS((cur) => {
        const n = journeys.find((j) => j.id === cur.journey)?.steps.length ?? 0;
        return n === 0 ? cur : { ...cur, step: Math.max(0, Math.min(n - 1, i)) };
      });
    const pickJourney = (id: string) =>
      setS((cur) => ({ ...cur, journey: id, step: null, play: false, sel: null }));
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
      focusProject,
      crumb,
      clearAll,
      setHover,
      selectEdge,
      setDir,
      stepGo,
      pickJourney,
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
