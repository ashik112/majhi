import {
  edgeId,
  endpointId,
  isLoopbackHost,
  type MapEdge,
  type MapEdgeSource,
  type MapEdgeState,
  type MapEdgeType,
  type MapEndpoint,
  type MapEvidence,
  type MapNode,
} from "@majhi/shared";
import type { Store } from "./known.ts";

/** The most evidence one line keeps. */
const EVIDENCE_MAX = 12;

/** One line of proof as a pass found it. */
export type Proof = MapEvidence;

/** A project's use of a datastore. `address` is set when a connection URL names a remote host and database. */
export interface StoreRef {
  project: string;
  store: Store;
  via: "data" | "queue";
  proof?: Proof | undefined;
  address?: { host: string; port: number | undefined; db: string } | undefined;
}

function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Collects nodes and lines from the passes. The same node found twice is one node; the same line found
 * twice (same ends and type) is one line with all its proof. Datastores and outside services are not
 * boxes: they are chips on the project's card, except a datastore two projects both reach at the same
 * remote host, port and database. An address a project calls is kept as an endpoint, and becomes a line
 * only when something proves which project owns it (see `endpoints.ts`).
 */
export class MapBuilder {
  private readonly nodeById = new Map<string, MapNode>();
  private readonly edgeById = new Map<string, MapEdge>();
  private readonly chips = new Map<string, { stack: Set<string>; uses: Set<string> }>();
  private readonly storeRefs: StoreRef[] = [];
  private readonly endpointById = new Map<string, MapEndpoint>();

  constructor(
    private readonly source: MapEdgeSource,
    private readonly state: MapEdgeState,
  ) {}

  get nodes(): MapNode[] {
    return [...this.nodeById.values()].map((n) => {
      const chips = this.chips.get(n.id);
      const stack = chips === undefined ? [] : [...chips.stack];
      const uses = chips === undefined ? [] : [...chips.uses];
      return {
        ...n,
        ...(stack.length === 0 ? {} : { stack: stack.slice(0, 8) }),
        ...(uses.length === 0 ? {} : { uses: uses.slice(0, 12) }),
      };
    });
  }

  get edges(): MapEdge[] {
    return [...this.edgeById.values()];
  }

  get endpoints(): MapEndpoint[] {
    return [...this.endpointById.values()];
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

  /** A small tag on a project's card: what it is built with (`stack`) or which outside service it uses (`uses`). */
  chip(project: string, kind: "stack" | "uses", label: string): void {
    const at = this.chips.get(project) ?? { stack: new Set<string>(), uses: new Set<string>() };
    at[kind].add(label);
    this.chips.set(project, at);
  }

  /** A project that uses a datastore: a chip on its card, unless another project uses the very same one. */
  storeRef(ref: StoreRef): void {
    this.storeRefs.push(ref);
  }

  /**
   * An address a project's files call. A local address belongs to the project that wrote it. `known` is
   * the project a compose file proves owns the host name.
   */
  endpoint(e: {
    host: string;
    port: number | undefined;
    from: string;
    key: string;
    proof: Proof;
    known: string | undefined;
  }): void {
    const host = e.host.toLowerCase();
    const scope = isLoopbackHost(host) ? e.from : undefined;
    const id = endpointId(host, e.port, scope);
    const ref = { ...e.proof, key: e.key.slice(0, 120), source: "config" as const };
    const had = this.endpointById.get(id);
    if (had === undefined) {
      this.endpointById.set(id, {
        id,
        host,
        ...(e.port === undefined ? {} : { port: e.port }),
        ...(scope === undefined ? {} : { scope }),
        ...(e.known === undefined ? {} : { known: e.known }),
        refs: [ref],
      });
      return;
    }
    if (had.refs.length >= EVIDENCE_MAX) return;
    if (!had.refs.some((r) => r.project === ref.project && r.file === ref.file && r.line === ref.line)) {
      this.endpointById.set(id, { ...had, refs: [...had.refs, ref] });
    }
  }

  /**
   * Turns the datastore uses into boxes and chips. Two projects whose connection URLs name the same
   * remote host, port and database share one box; every other use is a chip on the project's own card,
   * because a driver or a local name proves only that the project uses that kind of store.
   */
  finishStores(): void {
    const shared = new Map<string, StoreRef[]>();
    for (const ref of this.storeRefs) {
      if (ref.address === undefined) continue;
      const key = `${ref.store.slug}@${ref.address.host}:${ref.address.port ?? ""}/${ref.address.db}`;
      shared.set(key, [...(shared.get(key) ?? []), ref]);
    }
    // A project that runs jobs through a store (a queue driver) makes that store a queue for everyone.
    const queued = new Set(
      this.storeRefs.filter((r) => r.via === "queue").map((r) => `${r.project}|${r.store.slug}`),
    );
    const boxed = new Set<StoreRef>();
    for (const [key, refs] of shared) {
      if (new Set(refs.map((r) => r.project)).size < 2) continue;
      const first = refs[0] as StoreRef;
      const where = first.address as NonNullable<StoreRef["address"]>;
      const queue =
        first.store.kind === "queue" || refs.some((r) => queued.has(`${r.project}|${r.store.slug}`));
      const id = `store:${key.length > 52 ? `${first.store.slug}-${hashOf(key)}` : key}`;
      this.node({
        id,
        kind: queue ? "queue" : first.store.kind,
        label: first.store.label,
        sub: `${where.host}${where.port === undefined ? "" : `:${where.port}`}${where.db === "" ? "" : `/${where.db}`}`,
      });
      for (const ref of refs) {
        boxed.add(ref);
        this.edge({
          from: ref.project,
          to: id,
          type: queue ? "queue" : "data",
          label: queue ? "jobs" : where.db === "" ? "data" : where.db,
          proof: ref.proof,
        });
      }
    }
    // A store a project reaches through a shared box is already drawn: no chip for the same one.
    const drawn = new Set([...boxed].map((r) => `${r.project}|${r.store.slug}`));
    for (const ref of this.storeRefs) {
      if (!boxed.has(ref) && !drawn.has(`${ref.project}|${ref.store.slug}`)) {
        this.chip(ref.project, "stack", ref.store.label);
      }
    }
  }

  edge(e: { from: string; to: string; type: MapEdgeType; label: string; proof?: Proof | undefined }): void {
    if (e.from === e.to) return;
    const id = edgeId(e.from, e.to, e.type);
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
        confidence: "extracted",
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
