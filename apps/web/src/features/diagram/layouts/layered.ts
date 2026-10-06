import { type Diagram, type DiagramNode, edgeKey } from "@majhi/shared";
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk-api.js";
import { fontsReady, labelSize, nodeSize } from "../measure";
import type { Box, EdgePath, LayoutOptions, Point, Positioned } from "../types";
import { routeEdges } from "./route";

export interface LayeredOptions {
  /** `AUTO` lays out across and down and hands both to the canvas: across when it fits the frame, else down. */
  direction: "RIGHT" | "DOWN" | "AUTO";
  /** Space between boxes of one layer, and between layers (a layer of a top-down picture needs less: labels sit on the lines). */
  nodeGap: number;
  layerGap: number;
  layerGapDown?: number;
}

/** The ids of the nodes that hold others: the ones some node names as its `group`. */
export function containersOf(diagram: Diagram): Set<string> {
  return new Set(diagram.nodes.flatMap((n) => (n.group === undefined ? [] : [n.group])));
}

/** Room inside a group's frame: its name on top, a margin around the boxes. */
const FRAME_PAD = { top: 32, side: 16, bottom: 16 };
/** Room around the whole drawing. */
const MARGIN = 6;

/** ELK runs in a web worker, so laying out a big diagram never freezes the page. */
const elk = new ELK({ workerUrl: new URL("elkjs/lib/elk-worker.min.js", import.meta.url).href });

/**
 * Layers by ELK: boxes sized to their words, lines routed at right angles around the boxes, and every
 * label placed by ELK as a box of its own, on its line, so a label never meets a box or another label. A
 * group is a frame ELK sizes around its boxes, and a line from a box in one group to a box in another is
 * routed across the frames. Flow, top-down, tree and state use this with different directions and spacing.
 * A line from a box to itself, and a "changes together" line (which says nothing about order), are not
 * given to ELK: they are drawn as curves afterwards.
 */
export async function layered(
  diagram: Diagram,
  options: LayeredOptions,
  layout: LayoutOptions,
): Promise<Positioned> {
  await fontsReady();
  if (options.direction !== "AUTO") return run(diagram, { ...options, direction: options.direction }, layout);
  const [across, down] = await Promise.all([
    run(diagram, { ...options, direction: "RIGHT" }, layout),
    run(diagram, { ...options, direction: "DOWN" }, layout),
  ]);
  return { ...across, variants: [down] };
}

async function run(
  diagram: Diagram,
  options: LayeredOptions & { direction: "RIGHT" | "DOWN" },
  { action }: LayoutOptions,
): Promise<Positioned> {
  const byId = new Map<string, DiagramNode>(diagram.nodes.map((n) => [n.id, n]));
  const containers = containersOf(diagram);
  const kids = new Map<string | undefined, DiagramNode[]>();
  for (const n of diagram.nodes) {
    // A group that does not exist is no group: the box stands on its own.
    const parent = n.group !== undefined && byId.has(n.group) ? n.group : undefined;
    kids.set(parent, [...(kids.get(parent) ?? []), n]);
  }
  const build = (n: DiagramNode): ElkNode => {
    const inside = kids.get(n.id);
    if (containers.has(n.id) && inside !== undefined) {
      return {
        id: n.id,
        layoutOptions: {
          "elk.padding": `[top=${FRAME_PAD.top},left=${FRAME_PAD.side},bottom=${FRAME_PAD.bottom},right=${FRAME_PAD.side}]`,
        },
        children: inside.map(build),
      };
    }
    const size = nodeSize(n, action.has(n.id));
    return {
      id: n.id,
      width: size.w,
      height: size.h,
      // A box that names its column keeps it: the layer is the rank.
      ...(n.rank === undefined
        ? {}
        : { layoutOptions: { "elk.layered.layering.layerChoiceConstraint": String(n.rank) } }),
    };
  };

  const edges: ElkExtendedEdge[] = [];
  const kept: { key: string; index: number }[] = [];
  diagram.edges.forEach((e, i) => {
    if (e.from === e.to || e.type === "together" || !byId.has(e.from) || !byId.has(e.to)) return;
    const size = labelSize(e);
    const label =
      e.label === undefined
        ? []
        : [{ id: `l${i}`, text: e.label, width: size.w, height: size.h, layoutOptions: LABEL }];
    edges.push({ id: `e${i}`, sources: [e.from], targets: [e.to], labels: label });
    kept.push({ key: edgeKey(e, i), index: i });
  });

  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": options.direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
      "elk.padding": `[top=${MARGIN},left=${MARGIN},bottom=${MARGIN},right=${MARGIN}]`,
      "elk.spacing.nodeNode": String(options.nodeGap),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(
        options.direction === "DOWN" ? (options.layerGapDown ?? options.layerGap) : options.layerGap,
      ),
      "elk.spacing.edgeNode": "16",
      "elk.spacing.edgeEdge": "14",
      "elk.layered.spacing.edgeNodeBetweenLayers": "12",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
      "elk.spacing.edgeLabel": "4",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    },
    children: (kids.get(undefined) ?? []).map(build),
    edges,
  };
  const laid = await elk.layout(root);

  const nodes = new Map<string, Box>();
  const groups = new Map<string, Box>();
  const visit = (n: ElkNode): void => {
    for (const child of n.children ?? []) {
      const box: Box = {
        x: child.x ?? 0,
        y: child.y ?? 0,
        w: child.width ?? 0,
        h: child.height ?? 0,
        fit: true,
      };
      if (child.children !== undefined && containers.has(child.id)) {
        groups.set(child.id, box);
        visit(child);
      } else nodes.set(child.id, box);
    }
  };
  visit(laid);

  const paths = new Map<string, EdgePath>();
  for (const e of laid.edges ?? []) {
    const edge = e as ElkExtendedEdge;
    const section = edge.sections?.[0];
    const mine = kept.find((k) => `e${k.index}` === edge.id);
    if (section === undefined || mine === undefined) continue;
    const route: Point[] = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    const l = edge.labels?.[0];
    const label: Box | undefined =
      l?.x === undefined || l.y === undefined
        ? undefined
        : { x: l.x, y: l.y, w: l.width ?? 0, h: l.height ?? 0 };
    const middle = route[Math.floor(route.length / 2)] ?? section.startPoint;
    paths.set(mine.key, {
      from: section.startPoint,
      via: middle,
      to: section.endPoint,
      mid: label === undefined ? middle : { x: label.x + label.w / 2, y: label.y + label.h / 2 },
      route,
      ...(label === undefined ? {} : { label }),
    });
  }
  // What ELK did not route: the curves of a box to itself and of "changes together".
  const loose = routeEdges(diagram, new Map([...nodes, ...groups]), nodes);
  for (const [key, p] of loose) if (!paths.has(key)) paths.set(key, p);
  return { nodes, groups, edges: paths, rules: [] };
}

/** A label sits on its line, in the middle: ELK leaves room for it between the layers. */
const LABEL = { "elk.edgeLabels.inline": "true" };
