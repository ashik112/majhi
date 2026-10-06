import { z } from "zod";

/**
 * A diagram an agent draws in the chat (`show_diagram`): typed JSON, never code. One renderer
 * draws it (the diagram canvas). Every string is data shown as text: a label is never read
 * as an instruction and never as HTML.
 */

export const DIAGRAM_LAYOUTS = [
  "flow",
  "top-down",
  "tree",
  "radial",
  "sequence",
  "timeline",
  "state",
  "lanes",
] as const;
export const DiagramLayoutSchema = z.enum(DIAGRAM_LAYOUTS);
export type DiagramLayout = z.infer<typeof DiagramLayoutSchema>;

export const DIAGRAM_TONES = ["neutral", "good", "warn", "bad", "accent"] as const;
export const DiagramToneSchema = z.enum(DIAGRAM_TONES);
export type DiagramTone = z.infer<typeof DiagramToneSchema>;

/** Presets for a line: the map's own kinds, and `step` for a plain sequence of steps. */
export const DIAGRAM_EDGE_TYPES = ["http", "queue", "data", "lib", "step", "deploy", "together"] as const;
export const DiagramEdgeTypeSchema = z.enum(DIAGRAM_EDGE_TYPES);
export type DiagramEdgeType = z.infer<typeof DiagramEdgeTypeSchema>;

export const DIAGRAM_LIMITS = { nodes: 40, edges: 80, label: 60, actors: 12 } as const;

const Label = z.string().trim().min(1).max(DIAGRAM_LIMITS.label);
const Key = z.string().trim().min(1).max(60);

export const DiagramNodeSchema = z.object({
  id: Key,
  label: Label,
  sub: z.string().trim().max(120).optional(),
  /** A small tag on the box, any short word: "service", "step", "decision". */
  kind: z.string().trim().min(1).max(24).optional(),
  /** The id of the box this one sits inside (for grouping, like "runs on Kubernetes"). */
  group: Key.optional(),
  tone: DiagramToneSchema.optional(),
  /** Lanes layout: the column inside the group the box sits in, left to right (0 is the first). */
  rank: z.number().int().min(0).max(9).optional(),
});
export type DiagramNode = z.infer<typeof DiagramNodeSchema>;

export const DiagramEdgeSchema = z.object({
  from: Key,
  to: Key,
  label: Label.optional(),
  type: DiagramEdgeTypeSchema.optional(),
  style: z.enum(["solid", "dashed", "dotted"]).optional(),
  tone: DiagramToneSchema.optional(),
  arrow: z.enum(["end", "both", "none"]).optional(),
  /** A small second line under the label, in the muted color: how the line is known ("exact route match"). */
  note: z.string().trim().min(1).max(40).optional(),
});
export type DiagramEdge = z.infer<typeof DiagramEdgeSchema>;

/** Bumped when the stored shape of a diagram changes, so stored maps and room items can be migrated. */
export const DIAGRAM_VERSION = 1;

export const DiagramSpecSchema = z
  .object({
    v: z.literal(DIAGRAM_VERSION).default(DIAGRAM_VERSION),
    title: z.string().trim().min(1).max(80),
    layout: DiagramLayoutSchema.default("flow"),
    nodes: z.array(DiagramNodeSchema).min(1).max(DIAGRAM_LIMITS.nodes),
    edges: z.array(DiagramEdgeSchema).max(DIAGRAM_LIMITS.edges).default([]),
    /** Sequence: the actors left to right. Without it, the boxes in the order given. */
    actors: z.array(Key).max(DIAGRAM_LIMITS.actors).optional(),
    /** The box to draw attention to; the center of a radial layout. */
    focus: Key.optional(),
  })
  .superRefine((spec, ctx) => {
    const ids = new Set<string>();
    spec.nodes.forEach((n, i) => {
      if (ids.has(n.id))
        ctx.addIssue({
          code: "custom",
          path: ["nodes", i, "id"],
          message: `Two boxes have the id "${n.id}"`,
        });
      ids.add(n.id);
    });
    spec.nodes.forEach((n, i) => {
      if (n.group === undefined) return;
      if (!ids.has(n.group) || n.group === n.id) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", i, "group"],
          message: `The group "${n.group}" is not another box`,
        });
        return;
      }
      // A box inside itself through its parents.
      const seen = new Set([n.id]);
      let at: string | undefined = n.group;
      while (at !== undefined) {
        if (seen.has(at)) {
          ctx.addIssue({
            code: "custom",
            path: ["nodes", i, "group"],
            message: "Boxes cannot sit inside each other in a circle",
          });
          return;
        }
        seen.add(at);
        at = spec.nodes.find((m) => m.id === at)?.group;
      }
    });
    spec.edges.forEach((e, i) => {
      for (const end of ["from", "to"] as const) {
        if (!ids.has(e[end]))
          ctx.addIssue({ code: "custom", path: ["edges", i, end], message: `There is no box "${e[end]}"` });
      }
    });
    spec.actors?.forEach((a, i) => {
      if (!ids.has(a))
        ctx.addIssue({ code: "custom", path: ["actors", i], message: `There is no box "${a}"` });
    });
    if (spec.focus !== undefined && !ids.has(spec.focus)) {
      ctx.addIssue({ code: "custom", path: ["focus"], message: `There is no box "${spec.focus}"` });
    }
  });
export type DiagramSpec = z.infer<typeof DiagramSpecSchema>;
/** What an agent sends, before defaults. */
export type DiagramSpecInput = z.input<typeof DiagramSpecSchema>;

/**
 * What the one renderer draws: a stored map and a chat diagram are both this. A line may carry an `id`
 * (the map's lines do); the renderer keys the others by position.
 */
export interface Diagram {
  layout: DiagramLayout;
  nodes: readonly DiagramNode[];
  edges: readonly (DiagramEdge & { id?: string })[];
  actors?: readonly string[] | undefined;
  focus?: string | undefined;
}

/** The key of a line in a diagram: its own id, else its place in the list. */
export function edgeKey(edge: object, index: number): string {
  return "id" in edge && typeof edge.id === "string" ? edge.id : `e${index}`;
}
