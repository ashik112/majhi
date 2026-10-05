import {
  edgeId,
  type MapEdge,
  type MapEdgeSource,
  type MapEdgeState,
  type MapEdgeType,
  type MapEvidence,
  type MapNode,
} from "@majhi/shared";
import type { Outside, Store } from "./known.ts";

/** The most evidence one line keeps. */
const EVIDENCE_MAX = 12;

/** One line of proof as a pass found it. */
export type Proof = MapEvidence;

/**
 * Collects nodes and lines from the passes. The same node found twice is one node; the same line found
 * twice (same ends and type) is one line with all its proof. A queue line to a cache makes that node a queue.
 */
export class MapBuilder {
  private readonly nodeById = new Map<string, MapNode>();
  private readonly edgeById = new Map<string, MapEdge>();

  constructor(
    private readonly source: MapEdgeSource,
    private readonly state: MapEdgeState,
  ) {}

  get nodes(): MapNode[] {
    return [...this.nodeById.values()];
  }

  get edges(): MapEdge[] {
    return [...this.edgeById.values()];
  }

  node(node: MapNode): MapNode {
    const had = this.nodeById.get(node.id);
    if (had === undefined) {
      this.nodeById.set(node.id, node);
      return node;
    }
    // Facts fill in what the first sight did not know.
    const merged: MapNode = {
      ...had,
      kind: had.kind === "cache" && node.kind === "queue" ? "queue" : had.kind,
      ...(had.sub === undefined && node.sub !== undefined ? { sub: node.sub } : {}),
      ...(had.deploy === undefined && node.deploy !== undefined ? { deploy: node.deploy } : {}),
    };
    this.nodeById.set(node.id, merged);
    return merged;
  }

  has(id: string): boolean {
    return this.nodeById.has(id);
  }

  /** Changes what a node is: a project the others use as a library. */
  retype(id: string, kind: MapNode["kind"]): void {
    const had = this.nodeById.get(id);
    if (had !== undefined) this.nodeById.set(id, { ...had, kind });
  }

  get(id: string): MapNode | undefined {
    return this.nodeById.get(id);
  }

  store(store: Store): MapNode {
    return this.node({ id: `store:${store.slug}`, kind: store.kind, label: store.label });
  }

  outside(service: Outside): MapNode {
    return this.node({
      id: `outside:${service.slug}`,
      kind: "outside",
      label: service.label,
      deploy: "outside",
    });
  }

  edge(e: { from: string; to: string; type: MapEdgeType; label: string; proof?: Proof | undefined }): void {
    if (e.from === e.to) return;
    const id = edgeId(e.from, e.to, e.type);
    if (e.type === "queue") {
      const target = this.nodeById.get(e.to);
      if (target?.kind === "cache") this.nodeById.set(target.id, { ...target, kind: "queue" });
    }
    const had = this.edgeById.get(id);
    if (had === undefined) {
      this.edgeById.set(id, {
        id,
        from: e.from,
        to: e.to,
        type: e.type,
        label: e.label,
        evidence: e.proof === undefined ? [] : [e.proof],
        source: this.source,
        state: this.state,
      });
      return;
    }
    if (e.proof === undefined || had.evidence.length >= EVIDENCE_MAX) return;
    const same = had.evidence.some(
      (p) => p.project === e.proof?.project && p.file === e.proof.file && p.line === e.proof.line,
    );
    if (!same) this.edgeById.set(id, { ...had, evidence: [...had.evidence, e.proof] });
  }
}
