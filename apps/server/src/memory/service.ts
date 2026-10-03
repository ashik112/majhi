import {
  type Actor,
  detectSecrets,
  type Fact,
  type FactHit,
  type FactKind,
  type FactSource,
  type FactStatus,
  type MemoryAction,
  type MemoryEvent,
  type MemoryScope,
  parseScope,
  type Thread,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { Embedder } from "./embedder.ts";
import { renderMemorySection } from "./recall.ts";
import { RecordStore } from "./record-store.ts";
import { ProjectMemory } from "./records.ts";
import { contentWords } from "./repo-docs.ts";
import { hybridSearch } from "./search.ts";
import type { FactFilter, MemoryStore } from "./store.ts";

/** An agent may propose this many facts in one task. */
export const MAX_PROPOSALS_PER_TASK = 20;
/** How long a query or a new fact waits for the model to load before search goes on with keywords. */
export const EMBED_WAIT_MS = 30_000;
const FILL_BATCH = 32;

/** Called with each fact an agent proposes. Curation (duplicates, decisions) hooks in here. */
export type Curate = (fact: Fact) => Promise<void> | void;

/** What curation wrote into the log for a step it took by itself. */
export interface CurationNote {
  reason: string;
  /** 0 to 1. */
  confidence?: number | undefined;
  provider?: string | undefined;
}

/** The actor of a step curation took by itself. */
export const CURATION = "curation";

/** Steps the log can undo: the ones that moved a fact. */
const UNDOABLE: readonly MemoryAction[] = ["approved", "rejected", "retired", "duplicate"];

export interface MemoryDeps {
  store: MemoryStore;
  /** Absent, or failing: search uses keywords only and vectors are filled in later. */
  embedder?: Embedder | undefined;
  /** Errors here never fail a proposal. The curator is wired in after the decision provider exists. */
  curate?: Curate | undefined;
  now?: () => Date;
  embedWaitMs?: number;
}

export function actorName(actor: Actor): string {
  return actor.kind === "owner" ? "owner" : `agent:${actor.id}`;
}

export interface Recalled {
  /** The lessons in the section. */
  facts: Fact[];
  /** The section, without its heading. Empty when memory has nothing for the task. */
  text: string;
  /** Only keywords ranked them. */
  keywordOnly: boolean;
}

/** majhi memory (SPEC 5.6): facts, their status, hybrid search and recall. */
export class MemoryService {
  private readonly store: MemoryStore;
  private readonly now: () => Date;
  private filling = false;
  private curate: Curate | undefined;
  private listener: (() => void) | undefined;
  private waitingListener: ((fact: Fact) => void) | undefined;
  /** Task records, project briefs and open threads, in the same database. */
  readonly project: ProjectMemory;

  constructor(private readonly deps: MemoryDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.curate = deps.curate;
    this.project = new ProjectMemory({
      store: new RecordStore(deps.store.database),
      embed: (texts) => this.embed(texts),
      now: this.now,
      onChange: () => this.changed(),
    });
  }

  /** Called when memory changed outside a command (the Housekeeper, curation), so the UI refreshes. */
  onChange(listener: () => void): void {
    this.listener = listener;
  }

  /** Called with each fact that curation left waiting for review, so the captain can count the backlog. */
  onWaiting(listener: (fact: Fact) => void): void {
    this.waitingListener = listener;
  }

  /** A fact was left waiting for review after curation. */
  waiting(fact: Fact): void {
    try {
      this.waitingListener?.(fact);
    } catch {
      // Nothing to do: the fact waits either way.
    }
  }

  /** Tells the UI that memory changed. */
  changed(): void {
    try {
      this.listener?.();
    } catch {
      // Nothing to do.
    }
  }

  /** Unit vectors for the texts, or undefined when the model is not there (or still loading). */
  async embed(texts: readonly string[]): Promise<Float32Array[] | undefined> {
    const embedder = this.embedder();
    if (embedder === undefined || texts.length === 0) return undefined;
    try {
      return await embedder.embed(texts);
    } catch {
      return undefined;
    }
  }

  private cardText: ((project: string) => string | undefined) | undefined;

  /** Where a project's compact knowledge card comes from, for TASK.md. Built after the memory, so it is set here. */
  useCards(text: (project: string) => string | undefined): void {
    this.cardText = text;
  }

  /** Hooks curation into proposals. Built after the decision provider, so it is set here. */
  useCurator(curate: Curate): void {
    this.curate = curate;
  }

  // ---------------------------------------------------------------------------
  // Adding

  /** An agent's proposal: a pending fact, handed to curation. */
  async propose(input: { text: string; scope: MemoryScope; task: string; agent: string }): Promise<Fact> {
    refuseSecrets(input.text);
    // Only what agents proposed counts: the Housekeeper's candidates do not use up the agent's share.
    if (this.store.proposalsBy(input.task) >= MAX_PROPOSALS_PER_TASK) {
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
      await this.curate?.(fact);
    } catch {
      // Curation is extra: the fact stays pending for the owner.
    }
    const after = this.mustGet(fact.id);
    if (after.status === "pending") this.waiting(after);
    return after;
  }

  /**
   * A fact the Housekeeper wrote from a finished task: pending, like a proposal, but logged under
   * the Housekeeper and not counted against the agents' share of `MAX_PROPOSALS_PER_TASK`.
   */
  async addCandidate(input: {
    text: string;
    scope: MemoryScope;
    task: string;
    agent: string;
    kind?: FactKind | undefined;
    source?: FactSource | undefined;
    /** Why it went where it did, for the log. */
    reason?: string | undefined;
  }): Promise<Fact> {
    refuseSecrets(input.text);
    const fact = this.store.insert({
      text: input.text,
      scope: input.scope,
      kind: input.kind,
      source: input.source,
      task: input.task,
      agent: input.agent,
      status: "pending",
      at: this.at(),
    });
    this.log(fact, "proposed", `housekeeper:${input.agent}`, input.reason);
    await this.index(fact);
    return this.mustGet(fact.id);
  }

  /** The owner adds an active fact. */
  async add(input: { text: string; scope: MemoryScope; pinned: boolean }, actor: Actor): Promise<Fact> {
    refuseSecrets(input.text);
    const who = actorName(actor);
    const fact = this.store.insert({
      text: input.text,
      scope: input.scope,
      ...(who === "owner" ? { kind: "statement" as const, source: "owner" as const } : {}),
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

  /**
   * Approves or rejects every pending fact, or the pending ones among `ids`. Each is its own logged
   * step, so each can be undone. Facts that are no longer pending are skipped. Resolves how many moved.
   */
  decideAll(action: "approve" | "reject", ids: readonly number[] | undefined, actor: Actor): number {
    const pending =
      ids === undefined
        ? this.store.list({ status: "pending", limit: 10_000 })
        : this.store.byIds(ids).filter((f) => f.status === "pending");
    for (const fact of pending) {
      if (action === "approve") this.approve(fact.id, actor, "Approved with Approve all.");
      else this.reject(fact.id, actor, "Rejected with Reject all.");
    }
    return pending.length;
  }

  /** Retires an active fact: valid to is set, and it is no longer recalled. */
  forget(id: number, actor: Actor, reason?: string): Fact {
    return this.move(id, ["active"], "retired", "retired", actor, reason);
  }

  /**
   * The owner's edit: new words, a new scope, or both. Logged with what changed; the status stays.
   * New words are checked for secrets and embedded again.
   */
  async edit(
    id: number,
    patch: { text?: string | undefined; scope?: MemoryScope | undefined },
    actor: Actor,
  ): Promise<Fact> {
    const fact = this.mustGet(id);
    const text = patch.text === undefined || patch.text === fact.text ? undefined : patch.text;
    const scope = patch.scope === undefined || patch.scope === fact.scope ? undefined : patch.scope;
    if (text === undefined && scope === undefined) return fact;
    if (text !== undefined) refuseSecrets(text);
    this.store.edit(id, { text, scope });
    const changes = [
      scope === undefined ? undefined : `Moved from ${fact.scope} to ${scope}.`,
      text === undefined ? undefined : `New words, was: "${fact.text}"`,
    ].filter((c) => c !== undefined);
    this.log(fact, "edited", actorName(actor), changes.join(" "));
    const edited = this.mustGet(id);
    if (text !== undefined) await this.index(edited);
    return edited;
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
    return this.step(id, from, to, action, actorName(actor), { reason });
  }

  /** One logged move of a fact, refused when the fact is not in one of the `from` statuses. */
  private step(
    id: number,
    from: readonly FactStatus[],
    to: FactStatus,
    action: MemoryAction,
    who: string,
    note: { reason?: string | undefined; confidence?: number | undefined; provider?: string | undefined },
  ): Fact {
    const fact = this.mustGet(id);
    if (!from.includes(fact.status)) {
      throw new UserError(`Fact ${id} is ${fact.status}, so it cannot become ${to}.`, 409);
    }
    this.store.setStatus(id, to, { at: this.at(), decidedBy: who });
    this.log(fact, action, who, note.reason, {
      from: fact.status,
      confidence: note.confidence,
      provider: note.provider,
    });
    return this.mustGet(id);
  }

  // ---------------------------------------------------------------------------
  // Curation: steps taken without the owner, each logged with its reason and undoable

  /** A pending fact becomes active. */
  keep(id: number, note: CurationNote): Fact {
    return this.step(id, ["pending"], "active", "approved", CURATION, note);
  }

  /** A pending fact is dropped: it is kept as rejected. */
  drop(id: number, note: CurationNote): Fact {
    return this.step(id, ["pending"], "rejected", "rejected", CURATION, note);
  }

  /** An active fact stops being true: a newer one contradicts it. */
  retire(id: number, note: CurationNote): Fact {
    return this.step(id, ["active"], "retired", "retired", CURATION, note);
  }

  /** A pending fact is the same as `of`: it is dropped and points at it. */
  merge(id: number, of: number, note: CurationNote): Fact {
    this.mustGet(of);
    const fact = this.step(id, ["pending"], "rejected", "duplicate", CURATION, note);
    this.store.setDuplicateOf(id, of);
    return this.mustGet(fact.id);
  }

  /**
   * A candidate that matches fact `of` is not added at all. The log says so on `of`, with the
   * candidate's words, and nothing changed, so there is nothing to undo.
   */
  noteDuplicate(of: number, candidate: { text: string; task: string }, note: CurationNote): void {
    const fact = this.mustGet(of);
    this.store.logEvent({
      fact: fact.id,
      action: "duplicate",
      actor: CURATION,
      task: candidate.task,
      reason: `Not added, same as this fact: "${candidate.text}". ${note.reason}`,
      ...(note.confidence === undefined ? {} : { confidence: note.confidence }),
      ...(note.provider === undefined ? {} : { provider: note.provider }),
      at: this.at(),
    });
  }

  /**
   * Reverses one logged step and logs the reversal. The fact must still be where the step left it:
   * a later change comes off first. A candidate that was never added has nothing to restore.
   */
  undo(eventId: number, actor: Actor): Fact {
    const event = this.store.getEvent(eventId);
    if (event === undefined) throw new UserError(`There is no event ${eventId} in the memory log.`, 404);
    if (event.undone) throw new UserError("That step is already undone.", 409);
    if (!UNDOABLE.includes(event.action)) {
      throw new UserError(`A "${event.action}" step cannot be undone.`, 409);
    }
    if (event.from === undefined) {
      throw new UserError(
        "That step changed no fact, so there is nothing to undo. Add the fact by hand.",
        409,
      );
    }
    const fact = this.mustGet(event.fact);
    const left = event.action === "approved" ? "active" : event.action === "retired" ? "retired" : "rejected";
    if (fact.status !== left) {
      throw new UserError(
        `Fact ${fact.id} is ${fact.status} now, not ${left}. Undo the later step first.`,
        409,
      );
    }
    const who = actorName(actor);
    this.store.restoreStatus(fact.id, event.from, who);
    if (event.action === "duplicate") this.store.setDuplicateOf(fact.id, null);
    this.store.markUndone(event.id);
    this.log(fact, "restored", who, `Undid step ${event.id} (${event.action}). Back to ${event.from}.`, {
      from: fact.status,
    });
    return this.mustGet(fact.id);
  }

  /** Marks the fact as promoted to a repo's AGENTS.md by `task`. */
  setPromoted(id: number, task: string, actor: Actor): Fact {
    const fact = this.mustGet(id);
    this.store.setPromoted(id, task);
    this.log(fact, "promoted", actorName(actor), `Added to AGENTS.md by ${task}.`);
    return this.mustGet(id);
  }

  /** Facts the promotion task `task` was to add to AGENTS.md. */
  promotedBy(task: string): Fact[] {
    return this.store.promotedBy(task);
  }

  /** The promotion did not happen: the fact can be promoted again. */
  clearPromoted(id: number, reason: string): Fact {
    const fact = this.mustGet(id);
    this.store.setPromoted(id, null);
    this.log(fact, "unpromoted", "majhi", reason);
    return this.mustGet(id);
  }

  /**
   * The facts nearest in meaning to a fact or a text, among active and pending facts in `scopes`,
   * nearest first, with cosine. Without a vector (no embedder, or it did not load) nothing is near.
   */
  async neighbours(
    target: { fact: Fact } | { text: string },
    scopes: readonly MemoryScope[],
    limit = 5,
  ): Promise<{ fact: Fact; cosine: number }[]> {
    let vector: Float32Array | undefined;
    if ("fact" in target) vector = this.store.vectorOf(target.fact.id);
    if (vector === undefined) {
      const embedder = this.embedder();
      if (embedder === undefined) return [];
      const text = "fact" in target ? target.fact.text : target.text;
      try {
        [vector] = await embedder.embed([text]);
      } catch {
        return [];
      }
    }
    if (vector === undefined) return [];
    return this.store.nearest(vector, scopes, ["active", "pending"], limit, {
      minCosine: 0,
      ...("fact" in target ? { except: target.fact.id } : {}),
    });
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
   * The Memory section of a task's TASK.md (about 1500 tokens): the briefs of its projects, the three
   * past task records most like its brief, the open threads of its projects and the lessons (pinned
   * first, then the best matches). The text is kept for the task, so rewriting TASK.md gives the same
   * section; the task's recalls are replaced and each new lesson's use count goes up.
   */
  async recall(
    task: { id: string; brief: string; title?: string | undefined },
    scopes: readonly MemoryScope[],
  ): Promise<Recalled> {
    const query = [task.title ?? "", task.brief].join("\n").trim();
    const result = await hybridSearch(this.store, this.embedder(), query, { scopes });
    const ordered = new Map<number, Fact>();
    for (const fact of this.store.pinned(scopes)) ordered.set(fact.id, fact);
    for (const { fact } of result.hits) if (!ordered.has(fact.id)) ordered.set(fact.id, fact);
    const projects = scopes.flatMap((s) => {
      const parsed = parseScope(s);
      return parsed?.kind === "project" ? [parsed.id] : [];
    });
    // Records are never global: the task's org and projects only.
    const recordScopes = scopes.filter((s) => s !== "global");
    const records =
      recordScopes.length === 0
        ? []
        : await this.project.records({ query, scopes: recordScopes, except: task.id, limit: 3 });
    const threads = rankThreads(this.project.threads({ projects, status: "open", limit: 100 }), query);
    const briefs = projects.flatMap((p) => {
      const b = this.project.currentBrief(p);
      return b === undefined ? [] : [{ project: p, body: b.body }];
    });
    const cards = projects.flatMap((p) => {
      const text = this.cardText?.(p);
      return text === undefined ? [] : [{ project: p, text }];
    });
    const { text, lessons } = renderMemorySection({
      briefs,
      cards,
      records: records.map((h) => h.record),
      threads,
      lessons: [...ordered.values()],
    });
    this.store.recordRecall(
      task.id,
      lessons.map((f) => f.id),
    );
    this.project.setTaskMemory(task.id, text);
    if (!result.keywordOnly) this.fillLater();
    return { facts: lessons, text, keywordOnly: result.keywordOnly };
  }

  /** The Memory section a task got at its start, for rewriting TASK.md. Empty before. */
  recalledText(task: string): string {
    return this.project.taskMemory(task) ?? "";
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

  private log(
    fact: Fact,
    action: MemoryEvent["action"],
    actor: string,
    reason?: string,
    extra: { from?: FactStatus; confidence?: number | undefined; provider?: string | undefined } = {},
  ): void {
    this.store.logEvent({
      fact: fact.id,
      action,
      actor,
      ...(fact.task === undefined ? {} : { task: fact.task }),
      ...(reason === undefined ? {} : { reason }),
      ...(extra.from === undefined ? {} : { from: extra.from }),
      ...(extra.confidence === undefined ? {} : { confidence: extra.confidence }),
      ...(extra.provider === undefined ? {} : { provider: extra.provider }),
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

/** Open threads that share the most words with the query first, then the newest. */
export function rankThreads(threads: readonly Thread[], query: string): Thread[] {
  const words = new Set(contentWords(query));
  const score = (t: Thread) => contentWords(t.text).filter((w) => words.has(w)).length;
  return [...threads].sort((a, b) => score(b) - score(a) || b.id - a.id);
}
