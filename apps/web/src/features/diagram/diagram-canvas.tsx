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
import { memo, type ReactNode, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { EDGE_PRESETS, edgeLook, TONE_COLOR } from "./presets";
import { BOX_H, BOX_W, type Box, type EdgePath, type Positioned, type Rule } from "./types";

export type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string } | undefined;

/** What a page adds to one box: it knows things the diagram does not (tasks, a week's changes). */
export interface NodeDecor {
  dim?: boolean;
  lamp?: { state: LampState; word: string };
  /** A short bold word after the kind tag, like CHANGED. */
  tag?: string;
  /** Replaces the sub line. */
  caption?: string;
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
  className?: string;
}

interface BoxData extends Record<string, unknown> {
  node: DiagramNode;
  decor: NodeDecor;
  selected: boolean;
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
}

type BoxNode = Node<BoxData, "box">;
type GroupNode = Node<GroupData, "group">;
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
  const { node, decor, selected } = data;
  return (
    <div
      data-diagram-node={node.id}
      style={{ width: BOX_W, height: BOX_H }}
      className={cn(
        "cursor-pointer rounded-xl border border-glass-line bg-glass-strong px-3 py-2 shadow-glass transition-opacity duration-150",
        selected && ROW_SELECTED,
        decor.dim && "opacity-30",
      )}
    >
      <Handles />
      <div className="flex h-4 items-center gap-2">
        {node.kind !== undefined && (
          <span
            className="min-w-0 truncate font-mono text-[10px] tracking-[0.06em] uppercase"
            style={{ color: TONE_COLOR[node.tone ?? "neutral"] }}
          >
            {node.kind}
          </span>
        )}
        {decor.tag !== undefined && (
          <span className="font-mono text-[10px] font-semibold text-accent-text">{decor.tag}</span>
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
      <div className="truncate font-mono text-xs text-fg-faint" title={decor.caption ?? node.sub}>
        {decor.caption ?? node.sub ?? ""}
      </div>
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
  const { edge, path, decor, selected } = data;
  const look = edgeLook(edge);
  const d = `M ${path.from.x} ${path.from.y} Q ${path.via.x} ${path.via.y} ${path.to.x} ${path.to.y}`;
  const showLabel = edge.label !== undefined && decor.hideLabel !== true;
  return (
    <>
      <BaseEdge
        path={d}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        {...(markerStart === undefined ? {} : { markerStart })}
        interactionWidth={18}
        style={{
          stroke: look.color,
          strokeWidth: selected ? 2.6 : 1.6,
          strokeDasharray: look.dash,
          opacity: decor.dim ? 0.15 : edge.type === "together" ? 0.7 : 1,
        }}
      />
      {showLabel && (
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

const nodeTypes = { box: BoxView, group: GroupView, rule: RuleView };
const edgeTypes = { line: LineView };

function Controls() {
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
        onClick={() => void flow.fitView({ duration: 200, padding: 0.12 })}
      >
        <Maximize2 />
      </Button>
    </div>
  );
}

/** Fits the diagram to the canvas when what is drawn changes shape. */
function Refit({ shape }: { shape: Positioned }) {
  const flow = useReactFlow();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` is the trigger; the flow handle is stable.
  useEffect(() => {
    const frame = requestAnimationFrame(() => void flow.fitView({ duration: 200, padding: 0.12 }));
    return () => cancelAnimationFrame(frame);
  }, [shape]);
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

/**
 * The one canvas: draws a positioned diagram, with zoom, fit and click. The Map page and a chat diagram
 * are thin wrappers around it; they differ only in what they decorate and what a click does.
 */
export function DiagramCanvas({
  diagram,
  positioned,
  node,
  edge,
  selection,
  onSelect,
  legend,
  className,
}: DiagramCanvasProps): ReactNode {
  const flowNodes = useMemo(() => {
    const out: (BoxNode | GroupNode | RuleNode)[] = [];
    const labels = new Map(diagram.nodes.map((n) => [n.id, n.label]));
    for (const [id, box] of positioned.groups) {
      out.push({
        id,
        type: "group",
        position: { x: box.x, y: box.y },
        data: { label: labels.get(id) ?? id, w: box.w, h: box.h },
        selectable: false,
        draggable: false,
        focusable: false,
        zIndex: -2,
        style: { pointerEvents: "none" },
      });
    }
    positioned.rules.forEach((rule, i) => {
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
      const box = positioned.nodes.get(n.id);
      if (box === undefined) continue;
      out.push({
        id: n.id,
        type: "box",
        position: { x: box.x, y: box.y },
        width: BOX_W,
        height: BOX_H,
        draggable: false,
        data: {
          node: n,
          decor: node?.(n) ?? {},
          selected: selection?.kind === "node" && selection.id === n.id,
        },
      });
    }
    return out;
  }, [diagram, positioned, node, selection]);

  const flowEdges = useMemo(() => {
    const out: LineEdge[] = [];
    diagram.edges.forEach((e, i) => {
      const key = edgeKey(e, i);
      const path = positioned.edges.get(key);
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
        },
      });
    });
    return out;
  }, [diagram, positioned, edge, selection]);

  return (
    <div className={cn("relative h-full w-full", className)}>
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
          minZoom={0.2}
          maxZoom={1.8}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          onNodeClick={(_, n) => {
            if (n.type === "box") onSelect?.({ kind: "node", id: n.id });
          }}
          onEdgeClick={(_, e) => onSelect?.({ kind: "edge", id: e.id })}
          onPaneClick={() => onSelect?.(undefined)}
          className="!bg-transparent"
        >
          <Refit shape={positioned} />
          <Controls />
        </ReactFlow>
      </ReactFlowProvider>
      {legend !== undefined && (
        <div
          className={cn(
            "pointer-events-none absolute bottom-3 left-3 z-10 flex flex-wrap gap-4 rounded-lg px-3 py-1.5 text-sm text-fg-muted",
            GLASS,
          )}
        >
          {legend.map((type) => (
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
      )}
    </div>
  );
}
