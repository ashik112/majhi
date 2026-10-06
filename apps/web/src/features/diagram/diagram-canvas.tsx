import { type Diagram, type DiagramNode, edgeKey } from "@majhi/shared";
import "@xyflow/react/dist/style.css";
import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { Maximize2, Minus, Plus } from "lucide-react";
import {
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { cn } from "@/lib/cn";
import { fitSequence, SEQUENCE_PAD } from "./layouts/sequence";
import { withoutStepNumber } from "./measure";
import { EDGE_PRESETS, edgeLook, kindColor, type LegendKey } from "./presets";
import type { Box, EdgePath, Point, Positioned, Rule } from "./types";

export type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string } | undefined;

/** What a page adds to one box: a link under its text, for a box that leads to another page. */
export interface NodeDecor {
  action?: { label: string; onClick: () => void };
}

export interface DiagramCanvasProps {
  diagram: Diagram;
  /** From `usePositioned(diagram)` (the scene does it). Passed in so the canvas never lays out. */
  positioned: Positioned;
  node?: ((n: DiagramNode) => NodeDecor) | undefined;
  selection?: Selection;
  onSelect?: ((selection: Selection) => void) | undefined;
  /** What to explain in a bar under the drawing: kinds of line, guessed lines, a message's number. */
  legend?: readonly LegendKey[] | undefined;
  /** A control at the right end of the legend bar (Open full size). */
  corner?: ReactNode;
  /** The smallest zoom "fit" may use. A big picture goes lower than a chat diagram. */
  fitMin?: number | undefined;
  /** Zoom and fit buttons over the drawing. */
  controls?: boolean;
  /** Drawn at its own size, never scaled: the frame is as tall as the drawing, and a wider drawing scrolls sideways inside it. */
  autoHeight?: boolean;
  className?: string;
}

interface BoxData extends Record<string, unknown> {
  node: DiagramNode;
  box: Box;
  decor: NodeDecor;
  selected: boolean;
  /** A sequence's actor: the name centred in a narrow box. */
  compact: boolean;
}
interface GroupData extends Record<string, unknown> {
  label: string;
  w: number;
  h: number;
}
interface RuleData extends Record<string, unknown> {
  rule: Rule;
  w: number;
  h: number;
}
interface LineData extends Record<string, unknown> {
  edge: Diagram["edges"][number];
  path: EdgePath;
  selected: boolean;
  hovered: boolean;
  /** A message of a sequence: its number on the line, its words above the line. */
  step?: number;
}

type BoxNode = Node<BoxData, "box">;
type GroupNode = Node<GroupData, "frame">;
type RuleNode = Node<RuleData, "rule">;
type LineEdge = Edge<LineData, "line">;

const HIDDEN = { opacity: 0, pointerEvents: "none" } as const;
const Handles = () => (
  <>
    <Handle type="target" position={Position.Top} isConnectable={false} style={HIDDEN} />
    <Handle type="source" position={Position.Bottom} isConnectable={false} style={HIDDEN} />
  </>
);

const OUTSIDE = "outside";

/**
 * One box: a small colored word for what it is, its name, and a short line under it, all in the sans face. A
 * box sized to its words wraps; a fixed-size box cuts a long text with an ellipsis. An outside service is
 * dashed. A page may add a link under the text.
 */
const BoxView = memo(function BoxView({ data }: NodeProps<BoxNode>) {
  const { node, decor, selected, box, compact } = data;
  const wrap = box.fit === true;
  const outside = node.kind?.toLowerCase() === OUTSIDE;
  return (
    <div
      data-diagram-node={node.id}
      style={{ width: box.w, height: box.h }}
      className={cn(
        "flex cursor-pointer flex-col rounded-[10px] border bg-glass-strong shadow-glass transition-colors duration-150 hover:border-line-hover",
        outside ? "border-dashed border-line-bright" : "border-glass-line",
        compact ? "items-center px-2 py-2 text-center" : "px-3 py-2.5",
        selected && ROW_SELECTED,
      )}
    >
      <Handles />
      {node.kind !== undefined && !compact && (
        <div
          data-box-kind=""
          className="min-w-0 text-[11px] leading-[15px] font-medium [overflow-wrap:anywhere]"
          style={{ color: kindColor(node.kind, node.tone) }}
        >
          {node.kind}
        </div>
      )}
      <div
        data-box-title=""
        title={node.label}
        className={cn(
          "text-[14px] leading-5 font-semibold text-fg",
          wrap ? "[overflow-wrap:anywhere]" : "truncate",
        )}
      >
        {node.label}
      </div>
      {node.sub !== undefined && (
        <div
          data-box-sub=""
          title={node.sub}
          className={cn("text-sm leading-4 text-fg-muted", wrap ? "[overflow-wrap:anywhere]" : "truncate")}
        >
          {node.sub}
        </div>
      )}
      {decor.action !== undefined && (
        <button
          type="button"
          data-box-action=""
          onClick={(e) => {
            e.stopPropagation();
            decor.action?.onClick();
          }}
          className="nodrag mt-auto cursor-pointer self-start text-sm leading-4 text-fg-soft hover:text-fg hover:underline"
        >
          {decor.action.label}
        </button>
      )}
    </div>
  );
});

/** The dashed frame around the boxes of a group, its name inside at the top. */
const GroupView = memo(function GroupView({ data }: NodeProps<GroupNode>) {
  return (
    <div
      style={{ width: data.w, height: data.h }}
      className="relative rounded-2xl border border-dashed border-line-bright bg-raised/40"
    >
      <Handles />
      <span className="absolute top-2 left-3.5 max-w-[calc(100%-28px)] truncate text-xs font-medium text-fg-muted">
        {data.label}
      </span>
    </div>
  );
});

/** A quiet line behind the rest: a lifeline, the axis of a timeline. */
const RuleView = memo(function RuleView({ data }: NodeProps<RuleNode>) {
  const { rule, w, h } = data;
  return (
    <svg width={w} height={h} className="overflow-visible" aria-hidden="true">
      <line
        x1={rule.from.x < rule.to.x ? 0 : w}
        y1={rule.from.y < rule.to.y ? 0 : h}
        x2={rule.from.x < rule.to.x ? w : 0}
        y2={rule.from.y < rule.to.y ? h : 0}
        stroke="var(--c-line-bright)"
        strokeWidth="1.2"
        strokeDasharray={rule.dash}
      />
    </svg>
  );
});

/** The corners of a line rounded off, so a line at right angles reads as one stroke. */
function roundedPath(points: readonly Point[], radius = 8): string {
  const first = points[0];
  if (first === undefined) return "";
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const here = points[i];
    const next = points[i + 1];
    if (prev === undefined || here === undefined || next === undefined) continue;
    const before = Math.hypot(here.x - prev.x, here.y - prev.y) || 1;
    const after = Math.hypot(next.x - here.x, next.y - here.y) || 1;
    const r = Math.min(radius, before / 2, after / 2);
    const ax = here.x - ((here.x - prev.x) / before) * r;
    const ay = here.y - ((here.y - prev.y) / before) * r;
    const bx = here.x + ((next.x - here.x) / after) * r;
    const by = here.y + ((next.y - here.y) / after) * r;
    d += ` L ${ax} ${ay} Q ${here.x} ${here.y} ${bx} ${by}`;
  }
  const last = points[points.length - 1];
  return last === undefined || points.length < 2 ? d : `${d} L ${last.x} ${last.y}`;
}

const MARK = "nodrag nopan pointer-events-none absolute";

/** A line, an arrowhead each end the diagram asks for, and its label: a pill on the line, or a message's words above it. */
const LineView = memo(function LineView({ data, markerEnd, markerStart }: EdgeProps<LineEdge>) {
  if (data === undefined) return null;
  const { edge, path, selected, hovered, step } = data;
  const look = edgeLook(edge);
  const d =
    path.route === undefined
      ? `M ${path.from.x} ${path.from.y} Q ${path.via.x} ${path.via.y} ${path.to.x} ${path.to.y}`
      : roundedPath(path.route);
  const guessed = edge.style === "dotted";
  const lab = path.label;
  const at =
    lab === undefined
      ? undefined
      : { transform: `translate(${lab.x}px, ${lab.y}px)`, width: lab.w, height: lab.h };
  return (
    <>
      <BaseEdge
        path={d}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        {...(markerStart === undefined ? {} : { markerStart })}
        interactionWidth={18}
        style={{
          stroke: look.color,
          strokeWidth: selected || hovered ? 2.4 : 1.6,
          strokeDasharray: look.dash,
          opacity: edge.type === "together" ? 0.7 : 1,
        }}
      />
      {step !== undefined && (
        <EdgeLabelRenderer>
          <span
            data-step={step}
            style={{ transform: `translate(-50%, -50%) translate(${path.mid.x}px, ${path.mid.y}px)` }}
            className={cn(
              MARK,
              "grid size-5 place-items-center rounded-full border bg-glass-strong font-mono text-[11px] leading-none text-fg",
              guessed ? "border-dashed border-amber" : "border-line-bright",
              selected && "bg-selected",
            )}
          >
            {step}
          </span>
          {edge.label !== undefined && at !== undefined && (
            <span
              data-edge-label=""
              style={at}
              className={cn(
                MARK,
                "flex items-center px-0.5 text-sm leading-4 [overflow-wrap:anywhere] text-fg-soft",
                path.from.x === path.to.x ? "justify-start text-left" : "justify-center text-center",
                selected && "text-fg",
              )}
            >
              {edge.label}
            </span>
          )}
        </EdgeLabelRenderer>
      )}
      {step === undefined && edge.label !== undefined && (
        <EdgeLabelRenderer>
          <div
            data-edge-label=""
            data-diagram-edge=""
            style={at ?? { transform: `translate(-50%, -50%) translate(${path.mid.x}px, ${path.mid.y}px)` }}
            className={cn(
              "nodrag nopan pointer-events-auto absolute flex cursor-pointer flex-col items-center justify-center rounded-[5px] border bg-glass-strong px-1 text-center",
              at === undefined && "max-w-[220px]",
              selected ? "border-line-hover bg-selected" : "border-line-strong",
            )}
          >
            <span className="text-sm leading-4 [overflow-wrap:anywhere] text-fg-soft">{edge.label}</span>
            {edge.note !== undefined && (
              <span className={cn("text-[11px] leading-[14px]", guessed ? "text-amber" : "text-fg-faint")}>
                {edge.note}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

// "frame", not "group": xyflow styles a node type named group on its own.
const nodeTypes = { box: BoxView, frame: GroupView, rule: RuleView };
const edgeTypes = { line: LineView };

function Controls({ fitMin }: { fitMin: number }) {
  const flow = useReactFlow();
  return (
    <div className="absolute top-3 right-3 z-10 flex flex-col gap-1.5">
      <Button
        size="icon-sm"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => void flow.zoomIn({ duration: 150 })}
      >
        <Plus />
      </Button>
      <Button
        size="icon-sm"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => void flow.zoomOut({ duration: 150 })}
      >
        <Minus />
      </Button>
      <Button
        size="icon-sm"
        aria-label="Fit the diagram"
        title="Fit the diagram"
        onClick={() => void flow.fitView({ duration: 200, padding: FIT_PAD, minZoom: fitMin, maxZoom: 1 })}
      >
        <Maximize2 />
      </Button>
    </div>
  );
}

/** How much of the frame a fit leaves empty, on each side, as a share of it. */
const FIT_PAD = 0.04;
/** Room kept around a drawing that is shown at its own size. */
const NATURAL_PAD = 8;

/**
 * Fits the diagram to the canvas when what is drawn changes shape, and again when the canvas itself changes
 * size (a dialog opens at zero size and grows, a panel is resized).
 */
function Refit({
  shape,
  box,
  fitMin,
}: {
  shape: Positioned;
  box: RefObject<HTMLDivElement | null>;
  fitMin: number;
}) {
  const flow = useReactFlow();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` is the trigger; the flow handle is stable.
  useEffect(() => {
    const frame = requestAnimationFrame(
      () => void flow.fitView({ duration: 0, padding: FIT_PAD, minZoom: fitMin, maxZoom: 1 }),
    );
    return () => cancelAnimationFrame(frame);
  }, [shape]);
  useEffect(() => {
    const el = box.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    let timer: number | undefined;
    const watch = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => void flow.fitView({ duration: 0, padding: FIT_PAD, minZoom: fitMin, maxZoom: 1 }),
        80,
      );
    });
    watch.observe(el);
    return () => {
      window.clearTimeout(timer);
      watch.disconnect();
    };
  }, [box, flow, fitMin]);
  return null;
}

function bounds(from: { x: number; y: number }, to: { x: number; y: number }): Box {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    w: Math.max(1, Math.abs(to.x - from.x)),
    h: Math.max(1, Math.abs(to.y - from.y)),
  };
}

/** The box around everything drawn: boxes, frames, line corners and labels. */
function extent(p: Positioned): { x: number; y: number; w: number; h: number } {
  let l = Number.POSITIVE_INFINITY;
  let t = Number.POSITIVE_INFINITY;
  let r = Number.NEGATIVE_INFINITY;
  let b = Number.NEGATIVE_INFINITY;
  const grow = (x0: number, y0: number, x1 = x0, y1 = y0) => {
    l = Math.min(l, x0);
    t = Math.min(t, y0);
    r = Math.max(r, x1);
    b = Math.max(b, y1);
  };
  for (const box of [...p.nodes.values(), ...p.groups.values()])
    grow(box.x, box.y, box.x + box.w, box.y + box.h);
  for (const e of p.edges.values()) {
    for (const pt of e.route ?? [e.from, e.via, e.to]) grow(pt.x, pt.y);
    if (e.label !== undefined) grow(e.label.x, e.label.y, e.label.x + e.label.w, e.label.y + e.label.h);
  }
  if (l === Number.POSITIVE_INFINITY) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: l, y: t, w: Math.max(1, r - l), h: Math.max(1, b - t) };
}

/** The size of an element, kept up to date. Zero until it is measured. */
function useSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const read = () =>
      setSize((was) =>
        was.w === el.clientWidth && was.h === el.clientHeight
          ? was
          : { w: el.clientWidth, h: el.clientHeight },
      );
    read();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref]);
  return size;
}

/**
 * How much wider than its frame a drawing may be and still be drawn across: a bit of sideways scroll beats
 * a tall tower. It is the ratio of the name's 14px to the 12px under which text would be too small to read.
 */
const SCROLL_ALLOWANCE = 14 / 12;

/**
 * Which of a diagram's layouts to draw. Shown at its own size (`natural`, never scaled), the first that is no
 * wider than the frame (and its allowance), else the narrowest, which the frame then scrolls sideways. Fitted into a frame, the one
 * that fills it best, the first winning unless a later one is clearly larger.
 */
function pickLayout(p: Positioned, frame: { w: number; h: number }, natural: boolean): Positioned {
  const all = [p, ...(p.variants ?? [])];
  if (all.length === 1 || frame.w === 0) return p;
  if (natural) {
    const room = frame.w - 2 * NATURAL_PAD;
    return (
      all.find((q) => extent(q).w <= room * SCROLL_ALLOWANCE) ??
      all.reduce((best, q) => (extent(q).w < extent(best).w ? q : best))
    );
  }
  const reach = (q: Positioned) => {
    const e = extent(q);
    return Math.min(1, (frame.w * (1 - 2 * FIT_PAD)) / e.w, (frame.h * (1 - 2 * FIT_PAD)) / e.h);
  };
  return all.reduce((best, q) => (reach(q) > reach(best) * 1.12 ? q : best));
}

const LEGEND_MARK = { w: 26, h: 8 } as const;

function LegendMark({ keyed }: { keyed: LegendKey }) {
  if (keyed === "step") {
    return (
      <span
        aria-hidden="true"
        className="grid size-[14px] place-items-center rounded-full border border-line-bright font-mono text-[9px] leading-none text-fg"
      >
        1
      </span>
    );
  }
  const color = keyed === "proven" || keyed === "guessed" ? "var(--c-fg-muted)" : EDGE_PRESETS[keyed].color;
  const dash = keyed === "guessed" ? "2 4" : keyed === "proven" ? undefined : EDGE_PRESETS[keyed].dash;
  return (
    <svg
      width={LEGEND_MARK.w}
      height={LEGEND_MARK.h}
      viewBox="0 0 26 8"
      overflow="visible"
      aria-hidden="true"
    >
      <path d="M0 4H22" stroke={color} strokeWidth="1.6" strokeDasharray={dash} fill="none" />
      <path d="M26 4l-5-3v6z" fill={color} />
    </svg>
  );
}

const LEGEND_WORD: Record<"proven" | "guessed" | "step", string> = {
  proven: "proven",
  guessed: "guessed",
  step: "step number",
};

/** What each mark means: a bar under the drawing, with a control of the page at its right end. */
function Legend({ kinds, corner }: { kinds: readonly LegendKey[]; corner?: ReactNode }) {
  return (
    <div
      data-diagram-legend=""
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-1.5 text-sm text-fg-muted"
    >
      {kinds.map((k) => (
        <span key={k} className="flex items-center gap-1.5 whitespace-nowrap">
          <LegendMark keyed={k} />
          {k === "proven" || k === "guessed" || k === "step" ? LEGEND_WORD[k] : EDGE_PRESETS[k].legend}
        </span>
      ))}
      {corner !== undefined && <span className="ml-auto flex items-center">{corner}</span>}
    </div>
  );
}

/**
 * The one canvas: draws a positioned diagram, with zoom, fit and click. A chat diagram is a thin wrapper
 * around it; it differs only in what it decorates and what a click does.
 */
export function DiagramCanvas({
  diagram,
  positioned,
  node,
  selection,
  onSelect,
  legend,
  corner,
  fitMin = 0.6,
  controls = true,
  autoHeight = false,
  className,
}: DiagramCanvasProps): ReactNode {
  const sequence = diagram.layout === "sequence";
  const box = useRef<HTMLDivElement>(null);
  const frame = useSize(box);
  const frameW = frame.w;
  // A sequence is never scaled down to fit: its lanes spread over a wide frame, and a narrow one scrolls.
  const fitted = useMemo(
    () => (sequence ? fitSequence(positioned, frameW - 2 * SEQUENCE_PAD) : undefined),
    [sequence, positioned, frameW],
  );
  const natural = sequence || autoHeight;
  const chosen = useMemo(() => pickLayout(positioned, frame, natural), [positioned, frame, natural]);
  const placed = fitted?.positioned ?? chosen;

  const flowNodes = useMemo(() => {
    const out: (BoxNode | GroupNode | RuleNode)[] = [];
    const labels = new Map(diagram.nodes.map((n) => [n.id, n.label]));
    for (const [id, box] of placed.groups) {
      out.push({
        id,
        type: "frame",
        position: { x: box.x, y: box.y },
        data: { label: labels.get(id) ?? id, w: box.w, h: box.h },
        selectable: false,
        draggable: false,
        focusable: false,
        zIndex: -2,
        style: { pointerEvents: "none" },
      });
    }
    placed.rules.forEach((rule, i) => {
      const b = bounds(rule.from, rule.to);
      out.push({
        id: `rule:${i}`,
        type: "rule",
        position: { x: b.x, y: b.y },
        data: { rule, w: b.w, h: b.h },
        selectable: false,
        draggable: false,
        focusable: false,
        zIndex: -1,
        style: { pointerEvents: "none" },
      });
    });
    for (const n of diagram.nodes) {
      const box = placed.nodes.get(n.id);
      if (box === undefined) continue;
      out.push({
        id: n.id,
        type: "box",
        position: { x: box.x, y: box.y },
        width: box.w,
        height: box.h,
        draggable: false,
        data: {
          node: n,
          box,
          decor: node?.(n) ?? {},
          selected: selection?.kind === "node" && selection.id === n.id,
          compact: sequence,
        },
      });
    }
    return out;
  }, [diagram, placed, sequence, node, selection]);

  const [hover, setHover] = useState<string | undefined>();
  const flowEdges = useMemo(() => {
    const out: LineEdge[] = [];
    diagram.edges.forEach((e, i) => {
      const key = edgeKey(e, i);
      const path = placed.edges.get(key);
      if (path === undefined) return;
      const look = edgeLook(e);
      const marker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: look.color } as const;
      out.push({
        id: key,
        source: e.from,
        target: e.to,
        type: "line",
        ...(look.arrowEnd ? { markerEnd: marker } : {}),
        ...(look.arrowStart ? { markerStart: marker } : {}),
        data: {
          edge: sequence && e.label !== undefined ? { ...e, label: withoutStepNumber(e.label) } : e,
          path,
          selected: selection?.kind === "edge" && selection.id === key,
          hovered: hover === key,
          ...(sequence ? { step: i + 1 } : {}),
        },
      });
    });
    return out;
  }, [diagram, placed, sequence, selection, hover]);

  const handlers = {
    onNodeClick: (_: unknown, n: Node) => {
      if (n.type === "box") onSelect?.({ kind: "node", id: n.id });
    },
    onEdgeClick: (_: unknown, e: Edge) => onSelect?.({ kind: "edge", id: e.id }),
    onEdgeMouseEnter: (_: unknown, e: Edge) => setHover(e.id),
    onEdgeMouseLeave: () => setHover(undefined),
    onPaneClick: () => onSelect?.(undefined),
  };
  const bar = legend !== undefined && legend.length > 0 ? <Legend kinds={legend} corner={corner} /> : null;
  const loneCorner = bar === null && corner !== undefined;
  if (natural) {
    // Drawn at its own size: the frame is as tall as the drawing, and a drawing wider than the frame scrolls sideways.
    const drawn = fitted === undefined ? extent(chosen) : { x: 0, y: 0, w: fitted.width, h: fitted.height };
    const pad = fitted === undefined ? NATURAL_PAD : SEQUENCE_PAD;
    const width = Math.max(frameW, drawn.w + 2 * pad);
    const height = drawn.h + 2 * pad;
    return (
      <div className={cn("flex w-full flex-col", autoHeight ? "" : "h-full", className)}>
        <div
          ref={box}
          data-sequence-scroll={sequence ? "" : undefined}
          data-diagram-scroll=""
          className={cn("min-h-0 flex-1", sequence ? "overflow-auto" : "overflow-x-auto overflow-y-hidden")}
        >
          <div style={{ width, height }}>
            <ReactFlowProvider>
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                edgesFocusable
                elementsSelectable={false}
                viewport={{
                  x: fitted === undefined ? (width - drawn.w) / 2 - drawn.x : pad,
                  y: fitted === undefined ? pad - drawn.y : pad,
                  zoom: 1,
                }}
                onViewportChange={() => undefined}
                minZoom={1}
                maxZoom={1}
                panOnDrag={false}
                zoomOnScroll={false}
                zoomOnPinch={false}
                zoomOnDoubleClick={false}
                preventScrolling={false}
                proOptions={{ hideAttribution: true }}
                {...handlers}
                className="!bg-transparent"
              />
            </ReactFlowProvider>
          </div>
        </div>
        {bar}
        {loneCorner && <div className="flex justify-end px-3 py-1.5">{corner}</div>}
      </div>
    );
  }
  return (
    <div className={cn("flex h-full w-full flex-col", className)}>
      <div ref={box} className="relative min-h-0 flex-1">
        <ReactFlowProvider>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable
            elementsSelectable={false}
            minZoom={0.3}
            maxZoom={1.6}
            fitView
            fitViewOptions={{ padding: FIT_PAD, minZoom: fitMin, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            {...handlers}
            className="!bg-transparent"
          >
            <Refit shape={chosen} box={box} fitMin={fitMin} />
            {controls && <Controls fitMin={fitMin} />}
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      {bar}
      {loneCorner && <div className="flex justify-end px-3 py-1.5">{corner}</div>}
    </div>
  );
}
