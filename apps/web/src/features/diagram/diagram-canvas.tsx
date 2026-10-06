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
import { Lamp, type LampState } from "@/components/ui/lamp";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { fitSequence, SEQUENCE_PAD } from "./layouts/sequence";
import { EDGE_PRESETS, edgeLook, TONE_COLOR } from "./presets";
import { type Box, CARD_H, type EdgePath, type Positioned, type Rule } from "./types";

export type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string } | undefined;

/** What a page adds to one box: it knows things the diagram does not (tasks, a week's changes). */
export interface NodeDecor {
  dim?: boolean;
  lamp?: { state: LampState; word: string };
  /** A short bold word after the kind tag, like CHANGED. */
  tag?: string;
  /** Replaces the sub line. */
  caption?: string;
  /** Small pills on a tall card: what the box is built with. */
  chips?: readonly string[];
  /** A line on a tall card: the outside services it uses. */
  uses?: readonly string[];
}

export interface EdgeDecor {
  dim?: boolean;
  /** A short bold word after the label, like NEW. */
  badge?: string;
  hideLabel?: boolean;
}

export interface DiagramCanvasProps {
  diagram: Diagram;
  /** From `usePositioned(diagram)` (the scene does it). Passed in so the canvas never lays out. */
  positioned: Positioned;
  node?: ((n: DiagramNode) => NodeDecor) | undefined;
  edge?: ((key: string) => EdgeDecor) | undefined;
  selection?: Selection;
  onSelect?: ((selection: Selection) => void) | undefined;
  /** Kinds of line to explain in a legend under the canvas. */
  legend?: readonly (keyof typeof EDGE_PRESETS)[] | undefined;
  /** The smallest zoom "fit" may use. A big picture (the map) goes lower than a chat diagram. */
  fitMin?: number | undefined;
  className?: string;
}

interface BoxData extends Record<string, unknown> {
  node: DiagramNode;
  box: Box;
  decor: NodeDecor;
  selected: boolean;
  /** A sequence's actor: a narrower box, a smaller name. */
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
  decor: EdgeDecor;
  selected: boolean;
  hovered: boolean;
  /** A message of a sequence: its number on the line, its label above the line. */
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

/** One box: its kind tag, a lamp with its word when a page says so, its name and a short line under it. */
const BoxView = memo(function BoxView({ data }: NodeProps<BoxNode>) {
  const { node, decor, selected, box, compact } = data;
  const tall = box.h >= CARD_H;
  const chips = decor.chips ?? [];
  const uses = decor.uses ?? [];
  return (
    <div
      data-diagram-node={node.id}
      style={{ width: box.w, height: box.h }}
      className={cn(
        "cursor-pointer rounded-xl border border-glass-line bg-glass-strong py-2 shadow-glass transition-opacity duration-150",
        compact ? "px-2 text-center" : "px-3",
        selected && ROW_SELECTED,
        decor.dim && "opacity-30",
      )}
    >
      <Handles />
      <div className={cn("flex h-4 items-center gap-2", compact && "justify-center")}>
        {node.kind !== undefined && (
          <span
            className={cn(
              "min-w-0 truncate font-mono tracking-[0.06em] uppercase",
              compact ? "text-sm" : "text-[10px]",
            )}
            style={{ color: TONE_COLOR[node.tone ?? "neutral"] }}
          >
            {node.kind}
          </span>
        )}
        {decor.tag !== undefined && (
          <span
            className={cn("font-mono font-semibold text-accent-text", compact ? "text-sm" : "text-[10px]")}
          >
            {decor.tag}
          </span>
        )}
        {decor.lamp !== undefined && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
            <Lamp state={decor.lamp.state} size={7} />
            {decor.lamp.word}
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate text-base font-medium text-fg" title={node.label}>
        {node.label}
      </div>
      <div
        className={cn("truncate font-mono text-fg-faint", compact ? "text-sm" : "text-xs")}
        title={decor.caption ?? node.sub}
      >
        {decor.caption ?? node.sub ?? ""}
      </div>
      {tall && (
        <div className="mt-1 flex h-[18px] items-center gap-1 overflow-hidden" data-card-chips="">
          {chips.slice(0, 3).map((c) => (
            <span
              key={c}
              className="shrink-0 rounded border border-line-strong px-1.5 font-mono text-[10px] leading-4 text-fg-soft"
            >
              {c}
            </span>
          ))}
          {chips.length > 3 && (
            <span className="shrink-0 text-[10px] text-fg-muted">+{chips.length - 3}</span>
          )}
        </div>
      )}
      {tall && (
        <div
          className="mt-0.5 truncate text-[11px] leading-4 text-fg-muted"
          title={uses.length === 0 ? undefined : uses.join(", ")}
        >
          {uses.length === 0
            ? ""
            : `Uses ${uses.slice(0, 2).join(", ")}${uses.length > 2 ? ` +${uses.length - 2}` : ""}`}
        </div>
      )}
    </div>
  );
});

/** The dashed frame around the boxes of a group, its name above it. */
const GroupView = memo(function GroupView({ data }: NodeProps<GroupNode>) {
  return (
    <div
      style={{ width: data.w, height: data.h }}
      className="relative rounded-2xl border border-dashed border-line-bright bg-raised/40"
    >
      <Handles />
      <span className="absolute -top-5 left-3 max-w-full truncate font-mono text-xs text-fg-muted">
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

/** A line, an arrowhead each end the diagram asks for, and a small label that selects it when clicked. */
const LineView = memo(function LineView({ data, markerEnd, markerStart }: EdgeProps<LineEdge>) {
  if (data === undefined) return null;
  const { edge, path, decor, selected, hovered, step } = data;
  const loop = path.from.x === path.to.x;
  const look = edgeLook(edge);
  const d = `M ${path.from.x} ${path.from.y} Q ${path.via.x} ${path.via.y} ${path.to.x} ${path.to.y}`;
  const showLabel = edge.label !== undefined && (decor.hideLabel !== true || hovered || selected);
  return (
    <>
      <BaseEdge
        path={d}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        {...(markerStart === undefined ? {} : { markerStart })}
        interactionWidth={18}
        style={{
          stroke: look.color,
          strokeWidth: selected || hovered ? 2.6 : 1.6,
          strokeDasharray: look.dash,
          opacity: decor.dim ? 0.15 : edge.type === "together" ? 0.7 : 1,
        }}
      />
      {step !== undefined && (
        <EdgeLabelRenderer>
          <div
            data-diagram-edge={edge.id ?? ""}
            style={{ transform: `translate(${path.mid.x}px, ${path.mid.y}px)` }}
            className={cn("nodrag nopan pointer-events-none absolute size-0", decor.dim && "opacity-30")}
          >
            <span
              data-step={step}
              className={cn(
                "absolute grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border bg-glass-strong font-mono text-sm leading-none text-fg",
                selected ? "border-line-hover bg-selected" : "border-line-bright",
              )}
            >
              {step}
            </span>
            {showLabel && (
              <span
                style={{ maxWidth: loop ? 180 : Math.max(168, Math.abs(path.to.x - path.from.x)) }}
                className={cn(
                  "absolute line-clamp-2 w-max rounded-md bg-glass-strong px-1 font-mono text-sm [overflow-wrap:anywhere] text-fg-soft",
                  loop
                    ? "top-0 left-3.5 -translate-y-1/2 text-left"
                    : "bottom-3 left-0 -translate-x-1/2 text-center",
                  selected && "text-fg",
                )}
              >
                {edge.label}
                {decor.badge !== undefined && (
                  <span className="ml-1 font-semibold text-accent-text">{decor.badge}</span>
                )}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
      {step === undefined && showLabel && (
        <EdgeLabelRenderer>
          <div
            data-diagram-edge={edge.id ?? ""}
            style={{ transform: `translate(-50%, -50%) translate(${path.mid.x}px, ${path.mid.y}px)` }}
            className={cn(
              "nodrag nopan pointer-events-auto absolute flex max-w-[260px] cursor-pointer items-center gap-1.5 rounded-md border bg-glass-strong px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-fg-soft",
              selected ? "border-line-hover bg-selected text-fg" : "border-line-strong",
              decor.dim && "opacity-30",
            )}
          >
            <span className="truncate">{edge.label}</span>
            {decor.badge !== undefined && (
              <span className="font-semibold text-accent-text">{decor.badge}</span>
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
        onClick={() => void flow.fitView({ duration: 200, padding: 0.04, minZoom: fitMin, maxZoom: 1 })}
      >
        <Maximize2 />
      </Button>
    </div>
  );
}

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
      () => void flow.fitView({ duration: 200, padding: 0.04, minZoom: fitMin, maxZoom: 1 }),
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
        () => void flow.fitView({ duration: 0, padding: 0.04, minZoom: fitMin, maxZoom: 1 }),
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

/** What each kind of line means. On a canvas it floats at the bottom; under a sequence it is a bar of its own. */
function Legend({ kinds, bar }: { kinds: readonly (keyof typeof EDGE_PRESETS)[]; bar: boolean }) {
  return (
    <div
      className={cn(
        "pointer-events-none flex flex-wrap gap-4 px-3 py-1.5 text-sm text-fg-muted",
        bar ? "shrink-0 border-t border-line" : cn("absolute bottom-3 left-3 z-10 rounded-lg", GLASS),
      )}
    >
      {kinds.map((type) => (
        <span key={type} className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="22"
              y2="3"
              stroke={EDGE_PRESETS[type].color}
              strokeWidth="2"
              strokeDasharray={EDGE_PRESETS[type].dash}
            />
          </svg>
          {EDGE_PRESETS[type].legend}
        </span>
      ))}
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
  edge,
  selection,
  onSelect,
  legend,
  fitMin = 0.6,
  className,
}: DiagramCanvasProps): ReactNode {
  const sequence = diagram.layout === "sequence";
  const box = useRef<HTMLDivElement>(null);
  const [frameW, setFrameW] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!sequence || el === null) return;
    const read = () => setFrameW(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [sequence]);
  // A sequence is never scaled down to fit: its lanes spread over a wide frame, and a narrow one scrolls.
  const fitted = useMemo(
    () => (sequence ? fitSequence(positioned, frameW - 2 * SEQUENCE_PAD) : undefined),
    [sequence, positioned, frameW],
  );
  const placed = fitted?.positioned ?? positioned;

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
          edge: e,
          path,
          decor: edge?.(key) ?? {},
          selected: selection?.kind === "edge" && selection.id === key,
          hovered: hover === key,
          ...(sequence ? { step: i + 1 } : {}),
        },
      });
    });
    return out;
  }, [diagram, placed, sequence, edge, selection, hover]);

  const handlers = {
    onNodeClick: (_: unknown, n: Node) => {
      if (n.type === "box") onSelect?.({ kind: "node", id: n.id });
    },
    onEdgeClick: (_: unknown, e: Edge) => onSelect?.({ kind: "edge", id: e.id }),
    onEdgeMouseEnter: (_: unknown, e: Edge) => setHover(e.id),
    onEdgeMouseLeave: () => setHover(undefined),
    onPaneClick: () => onSelect?.(undefined),
  };
  if (fitted !== undefined) {
    return (
      <div className={cn("flex h-full w-full flex-col", className)}>
        <div ref={box} data-sequence-scroll="" className="min-h-0 flex-1 overflow-auto">
          <div
            style={{
              width: Math.max(frameW, fitted.width + 2 * SEQUENCE_PAD),
              height: fitted.height + 2 * SEQUENCE_PAD,
            }}
          >
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
                defaultViewport={{ x: SEQUENCE_PAD, y: SEQUENCE_PAD, zoom: 1 }}
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
        {legend !== undefined && <Legend kinds={legend} bar />}
      </div>
    );
  }
  return (
    <div ref={box} className={cn("relative h-full w-full", className)}>
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
          fitViewOptions={{ padding: 0.04, minZoom: fitMin, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          {...handlers}
          className="!bg-transparent"
        >
          <Refit shape={positioned} box={box} fitMin={fitMin} />
          <Controls fitMin={fitMin} />
        </ReactFlow>
      </ReactFlowProvider>
      {legend !== undefined && <Legend kinds={legend} bar={false} />}
    </div>
  );
}
