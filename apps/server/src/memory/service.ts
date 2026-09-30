import {
  type Actor,
  detectSecrets,
  type Fact,
  type FactHit,
  type FactStatus,
  type MemoryEvent,
  type MemoryScope,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { Embedder } from "./embedder.ts";
import { capFacts, RECALL_CHARS } from "./recall.ts";
import { hybridSearch } from "./search.ts";
import type { FactFilter, MemoryStore } from "./store.ts";

/** An agent may propose this many facts in one task. */
export const MAX_PROPOSALS_PER_TASK = 20;
/** How long a query or a new fact waits for the model to load before search goes on with keywords. */
export const EMBED_WAIT_MS = 10_000;
const FILL_BATCH = 32;

/** Called with each fact an agent proposes. Curation (Housekeeper, duplicates, decisions) hooks in here. */
export type Curate = (fact: Fact) => Promise<void> | void;

export interface MemoryDeps {
  store: MemoryStore;
  /** Absent, or failing: search uses keywords only and vectors are filled in later. */
  embedder?: Embedder | undefined;
  /** Part B fills this in. Errors here never fail a proposal. */
  curate?: Curate | undefined;
  now?: () => Date;
  embedWaitMs?: number;
}

export function actorName(actor: Actor): string {
  return actor.kind === "owner" ? "owner" : `agent:${actor.id}`;
}

export interface Recalled {
  facts: Fact[];
  /** Only keywords ranked them. */
  keywordOnly: boolean;
}

/** majhi memory (SPEC 5.6): facts, their status, hybrid search and recall. */
export class MemoryService {
  private readonly store: MemoryStore;
  private readonly now: () => Date;
  private filling = false;

  constructor(private readonly deps: MemoryDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // Adding

  /** An agent's proposal: a pending fact, handed to curation. */
  async propose(input: { text: string; scope: MemoryScope; task: string; agent: string }): Promise<Fact> {
    refuseSecrets(input.text);
    if (
      this.store.list({ task: input.task, limit: MAX_PROPOSALS_PER_TASK + 1 }).length >=
      MAX_PROPOSALS_PER_TASK
    ) {
      throw new UserError(
        `This task already proposed ${MAX_PROPOSALS_PER_TASK} facts. Ask the owner to review them first.`,
        409,
      );
    }
    const fact = this.store.insert({
      text: input.text,
      scope: input.scope,
      task: input.task,
      agent: input.agent,
      status: "pending",
      at: this.at(),
    });
    this.log(fact, "proposed", `agent:${input.agent}`);
    await this.index(fact);
    try {
      await this.deps.curate?.(fact);
    } catch {
      // Curation is extra: the fact stays pending for the owner.
    }
    return this.mustGet(fact.id);
  }

  /** The owner adds an active fact. */
  async add(input: { text: string; scope: MemoryScope; pinned: boolean }, actor: Actor): Promise<Fact> {
    refuseSecrets(input.text);
    const who = actorName(actor);
    const fact = this.store.insert({
      text: input.text,
      scope: input.scope,
      agent: who === "owner" ? "owner" : who.slice("agent:".length),
      status: "active",
      pinned: input.pinned,
      decidedBy: who,
      at: this.at(),
    });
    this.log(fact, "added", who);
    await this.index(fact);
    return this.mustGet(fact.id);
  }

  // ---------------------------------------------------------------------------
  // Status

  approve(id: number, actor: Actor, reason?: string): Fact {
    return this.move(id, ["pending", "rejected"], "active", "approved", actor, reason);
  }

  reject(id: number, actor: Actor, reason?: string): Fact {
    return this.move(id, ["pending"], "rejected", "rejected", actor, reason);
  }

  /** Retires an active fact: valid to is set, and it is no longer recalled. */
  forget(id: number, actor: Actor, reason?: string): Fact {
    return this.move(id, ["active"], "retired", "retired", actor, reason);
  }

  pin(id: number, pinned: boolean, actor: Actor): Fact {
    const fact = this.mustGet(id);
    if (fact.status !== "active")
      throw new UserError(`Fact ${id} is ${fact.status}. Only an active fact can be pinned.`, 409);
    if (fact.pinned === pinned) return fact;
    this.store.setPinned(id, pinned);
    this.log(fact, pinned ? "pinned" : "unpinned", actorName(actor));
    return this.mustGet(id);
  }

  private move(
    id: number,
    from: readonly FactStatus[],
    to: FactStatus,
    action: "approved" | "rejected" | "retired",
    actor: Actor,
    reason: string | undefined,
  ): Fact {
    const fact = this.mustGet(id);
    if (!from.includes(fact.status)) {
      throw new UserError(`Fact ${id} is ${fact.status}, so it cannot become ${to}.`, 409);
    }
    const who = actorName(actor);
    this.store.setStatus(id, to, { at: this.at(), decidedBy: who });
    this.log(fact, action, who, reason);
    return this.mustGet(id);
  }

  // ---------------------------------------------------------------------------
  // Reading

  get(id: number): Fact | undefined {
    return this.store.get(id);
  }

  list(filter: FactFilter): Fact[] {
    return this.store.list(filter);
  }

  /** Every scope that has a fact. */
  scopesInUse(): MemoryScope[] {
    return this.store.scopesInUse();
  }

  events(filter: {
    task?: string | undefined;
    fact?: number | undefined;
    limit?: number;
    offset?: number;
  }): MemoryEvent[] {
    return this.store.events(filter);
  }

  async search(
    query: string,
    options: { scopes: readonly MemoryScope[]; status?: FactStatus; limit?: number },
  ): Promise<FactHit[]> {
    const result = await hybridSearch(this.store, this.embedder(), query, options);
    if (!result.keywordOnly) this.fillLater();
    return result.hits;
  }

  /**
   * The facts for a task's TASK.md: pinned facts of the scopes, then the best matches for the brief,
   * cut at about 500 tokens. The task's recalls are replaced and each new fact's use count goes up.
   */
  async recall(task: { id: string; brief: string }, scopes: readonly MemoryScope[]): Promise<Recalled> {
    const result = await hybridSearch(this.store, this.embedder(), task.brief, { scopes });
    const ordered = new Map<number, Fact>();
    for (const fact of this.store.pinned(scopes)) ordered.set(fact.id, fact);
    for (const { fact } of result.hits) if (!ordered.has(fact.id)) ordered.set(fact.id, fact);
    const facts = capFacts([...ordered.values()], RECALL_CHARS);
    this.store.recordRecall(
      task.id,
      facts.map((f) => f.id),
    );
    if (!result.keywordOnly) this.fillLater();
    return { facts, keywordOnly: result.keywordOnly };
  }

  /** The facts a task was given at its start, for rewriting TASK.md without counting them again. */
  recalled(task: string): Fact[] {
    return this.store.recalled(task);
  }

  /** Counts facts an agent read through `recall` as used by the task, once each. */
  noteUse(task: string, facts: readonly Fact[]): void {
    this.store.noteUse(
      task,
      facts.map((f) => f.id),
    );
  }

  // ---------------------------------------------------------------------------
  // Vectors

  /** Embeds the facts that have no vector yet. Resolves how many it filled; 0 when the model is not there. */
  async fillVectors(limit = FILL_BATCH): Promise<number> {
    const embedder = this.embedder();
    if (embedder === undefined) return 0;
    const missing = this.store.withoutVector(limit);
    if (missing.length === 0) return 0;
    try {
      const vectors = await embedder.embed(missing.map((m) => m.text));
      missing.forEach((m, i) => {
        const v = vectors[i];
        if (v !== undefined) this.store.setVector(m.id, v);
      });
      return missing.length;
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    await this.deps.embedder?.unload?.();
    this.store.close();
  }

  private async index(fact: Fact): Promise<void> {
    const embedder = this.embedder();
    if (embedder === undefined) return;
    try {
      const [v] = await embedder.embed([fact.text]);
      if (v !== undefined) this.store.setVector(fact.id, v);
    } catch {
      // Filled in later.
    }
  }

  private fillLater(): void {
    if (this.filling || this.store.withoutVector(1).length === 0) return;
    this.filling = true;
    void this.fillVectors()
      .catch(() => undefined)
      .finally(() => {
        this.filling = false;
      });
  }

  /** The embedder, cut short after a wait so a model that is still loading never holds up a task. */
  private embedder(): Embedder | undefined {
    const inner = this.deps.embedder;
    if (inner === undefined) return undefined;
    const wait = this.deps.embedWaitMs ?? EMBED_WAIT_MS;
    return {
      embed: (texts) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("The embedding model is still loading.")), wait);
          inner.embed(texts).then(
            (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            (err: unknown) => {
              clearTimeout(timer);
              reject(err);
            },
          );
        }),
    };
  }

  private mustGet(id: number): Fact {
    const fact = this.store.get(id);
    if (fact === undefined) throw new UserError(`Fact ${id} does not exist.`, 404);
    return fact;
  }

  private log(fact: Fact, action: MemoryEvent["action"], actor: string, reason?: string): void {
    this.store.logEvent({
      fact: fact.id,
      action,
      actor,
      ...(fact.task === undefined ? {} : { task: fact.task }),
      ...(reason === undefined ? {} : { reason }),
      at: this.at(),
    });
  }

  private at(): string {
    return this.now().toISOString();
  }
}

/** Secrets never go into memory (SPEC 5.18). */
function refuseSecrets(text: string): void {
  if (detectSecrets(text).length > 0) {
    throw new UserError("That looks like it holds a secret. Facts never do: leave the value out.");
  }
}
