import {
  type Answer,
  type DecideRequestInput,
  type Fact,
  type MemoryExtractOutput,
  type MemoryScope,
  type MemorySettings,
  orgScope,
  parseScope,
} from "@majhi/shared";
import type { Decisions } from "../decisions/api.ts";
import { errorMessage } from "../errors.ts";
import type { Candidate } from "./housekeeper.ts";
import type { Placement, Placer } from "./placement.ts";
import { forbiddenReason } from "./rules.ts";
import type { MemoryService } from "./service.ts";

/** Cosine at or above which a candidate is the same fact as an existing one, without a model. */
export const DUPLICATE_COSINE = 0.92;
/** Cosine from which an existing fact is close enough to ask whether the candidate repeats or contradicts it. */
export const RELATED_COSINE = 0.75;

/** The task a fact came from, as curation needs it. */
export interface CurationTask {
  id: string;
  org?: string | undefined;
  /** Every project of the task's repos; for a chat, the projects it named or read. */
  projects: readonly string[];
}

export interface CuratorDeps {
  memory: MemoryService;
  decisions: Pick<Decisions, "decide" | "outcome">;
  /** The memory section of majhi.yaml, read at each use so changes apply at once. */
  settings: () => Promise<MemorySettings>;
  /** The task by id, or undefined when it is gone. */
  task: (id: string) => CurationTask | undefined;
  /** The scopes an agent of the task may use: global, its org, and the projects of that org. */
  allowed: (task: CurationTask) => Promise<readonly MemoryScope[]>;
  /**
   * The repo doc (CLAUDE.md, AGENTS.md, README) that already says the text, for a task's repos, or
   * undefined. A lesson that restates the repo docs is not kept.
   */
  inDocs?: (task: CurationTask | undefined, text: string) => Promise<string | undefined>;
  /** Decides each extracted fact's scope. Without it a fact keeps the Housekeeper's scope when allowed. */
  placer?: Pick<Placer, "place">;
}

export const EMPTY_COUNTS: MemoryExtractOutput = {
  candidates: 0,
  pending: 0,
  kept: 0,
  dropped: 0,
  duplicates: 0,
  rejected: 0,
  in_docs: 0,
  record: false,
  threads_opened: 0,
  threads_closed: 0,
  briefs: [],
};

type Outcome = "pending" | "kept" | "dropped" | "duplicate" | "rejected" | "in_docs";

/** The provider of a step taken because the repo docs already say it. */
export const REPO_DOCS = "repo-docs";

const KEEP = "keep";
const CHATTER = "chatter";
const SAME = "same";
const CONTRADICTS = "contradicts";
const UNRELATED = "unrelated";

/** Scopes at or wider than `scope`: the fact's own, its org's and global. */
function coveringScopes(scope: MemoryScope, org: string | undefined): MemoryScope[] {
  const parsed = parseScope(scope);
  const wider: MemoryScope[] = [scope];
  if (parsed?.kind === "project" && org !== undefined) wider.push(orgScope(org));
  if (parsed?.kind !== "global") wider.push("global");
  return [...new Set(wider)];
}

/**
 * Curation of lessons (SPEC 5.6, reworked): what happens to a lesson after an agent proposed it or
 * the Housekeeper wrote it. Every step is logged with its reason, confidence and provider, and can
 * be undone; nothing is deleted. An agent's proposal waits for the owner only when global or a
 * contradiction. Of the Housekeeper's facts, what the owner said is kept at once and what it
 * inferred (lessons, debugging playbooks) waits for review once curation has not dropped it.
 *
 * 1. Rules: a secret or personal data is rejected, whatever a model would say.
 * 2. Repo docs: a lesson the repo's CLAUDE.md, AGENTS.md or README already says is not kept.
 * 3. Duplicates, without a model: cosine 0.92 or more with an active or pending fact in the same
 *    or a wider scope. The candidate is the same fact.
 * 4. `review_all` and a global scope wait for the owner, without a model.
 * 5. Decide, one call on the decision provider: lasting lesson or chatter; against the nearest fact
 *    (cosine 0.75 to 0.92) the same, contradicting or unrelated; secret or personal data.
 * 6. Apply: a suspected secret is dropped; chatter the gate is sure of (a lift over chance of at
 *    least `auto_threshold`) is dropped; a sure "same" is merged; a contradiction waits for the
 *    owner; everything else is kept. Undo reverses any of it.
 */
export class Curator {
  constructor(private readonly deps: CuratorDeps) {}

  /** Where facts from the task may go. */
  scopesFor(task: CurationTask): Promise<readonly MemoryScope[]> {
    return this.deps.allowed(task);
  }

  /** An agent's proposal, already stored as pending. Never throws: the fact stays pending. */
  async curate(fact: Fact): Promise<void> {
    try {
      await this.run(fact, { checkDuplicate: true });
    } catch (err) {
      console.error(`Memory curation of fact ${fact.id} failed: ${errorMessage(err)}`);
    }
  }

  /**
   * The Housekeeper's facts for a task or a stretch of a chat, each placed in its own scope, stored
   * and curated. What the owner said is kept at once; what was inferred waits for the owner's
   * review unless curation drops it. Resolves what happened to them.
   */
  async curateCandidates(
    task: CurationTask,
    candidates: readonly Candidate[],
    agent: string,
  ): Promise<MemoryExtractOutput> {
    const counts = { ...EMPTY_COUNTS, candidates: candidates.length };
    const allowed = await this.deps.allowed(task);
    for (const candidate of candidates) {
      let outcome: Outcome = "pending";
      try {
        const placed = await this.place(task, allowed, candidate, agent);
        outcome = await this.candidate(task, { ...candidate, scope: placed.scope }, agent, placed);
      } catch (err) {
        console.error(`Memory curation of a candidate failed: ${errorMessage(err)}`);
      }
      if (outcome === "kept") counts.kept += 1;
      else if (outcome === "dropped") counts.dropped += 1;
      else if (outcome === "duplicate") counts.duplicates += 1;
      else if (outcome === "rejected") counts.rejected += 1;
      else if (outcome === "in_docs") counts.in_docs += 1;
      else counts.pending += 1;
    }
    return counts;
  }

  /**
   * Where one fact goes, never outside `allowed`: the placer's choice, else the Housekeeper's scope
   * when allowed, else the task's org (global without one).
   */
  private async place(
    task: CurationTask,
    allowed: readonly MemoryScope[],
    candidate: Candidate,
    agent: string,
  ): Promise<Placement> {
    const proposed = candidate.scope;
    const placed = await this.deps.placer
      ?.place(
        { task: task.id, agent, org: task.org, touched: task.projects, allowed },
        { text: candidate.text, proposed },
      )
      .catch(() => undefined);
    if (placed !== undefined && allowed.includes(placed.scope)) return placed;
    if (proposed !== undefined && allowed.includes(proposed))
      return { scope: proposed, by: "housekeeper", reason: "the Housekeeper's scope" };
    const fallback: MemoryScope = task.org === undefined ? "global" : orgScope(task.org);
    return {
      scope: allowed.includes(fallback) ? fallback : "global",
      by: "touched",
      reason: "the task's org",
    };
  }

  private async candidate(
    task: CurationTask,
    candidate: Candidate & { scope: MemoryScope },
    agent: string,
    placed?: Placement,
  ): Promise<Outcome> {
    const { memory } = this.deps;
    // What the rules forbid, or the repo docs already say, is not stored at all.
    if (forbiddenReason(candidate.text) !== undefined) return "rejected";
    if ((await this.deps.inDocs?.(task, candidate.text)) !== undefined) return "in_docs";
    const near = await memory.neighbours({ text: candidate.text }, coveringScopes(candidate.scope, task.org));
    const same = near[0];
    if (same !== undefined && same.cosine >= DUPLICATE_COSINE) {
      memory.noteDuplicate(
        same.fact.id,
        { text: candidate.text, task: task.id },
        { reason: `Cosine ${same.cosine.toFixed(2)}, so no model was asked.`, confidence: same.cosine },
      );
      return "duplicate";
    }
    const fact = await memory.addCandidate({
      text: candidate.text,
      scope: candidate.scope,
      kind: candidate.kind,
      source: candidate.source,
      task: task.id,
      agent,
      ...(placed === undefined ? {} : { reason: `Scope ${placed.scope}: ${placed.reason}.` }),
    });
    // The owner said it: it holds, wherever it goes, without a review.
    if (candidate.source === "owner") {
      memory.keep(fact.id, { reason: "The owner said it, so it holds without review.", provider: "owner" });
      return "kept";
    }
    return this.run(fact, { checkDuplicate: false, near, docsChecked: true, review: true });
  }

  /**
   * `review`: the fact was inferred by the Housekeeper, so curation may drop or merge it but never
   * keeps it: it waits for the owner.
   */
  private async run(
    fact: Fact,
    options: {
      checkDuplicate: boolean;
      near?: { fact: Fact; cosine: number }[];
      docsChecked?: boolean;
      review?: boolean;
    },
  ): Promise<Outcome> {
    const { memory } = this.deps;
    const why = forbiddenReason(fact.text);
    if (why !== undefined) {
      memory.drop(fact.id, {
        reason: `${why} Facts never hold secrets or personal data.`,
        provider: "rules",
      });
      return "rejected";
    }
    const task = fact.task === undefined ? undefined : this.deps.task(fact.task);
    if (options.docsChecked !== true) {
      const file = await this.deps.inDocs?.(task, fact.text);
      if (file !== undefined) {
        memory.drop(fact.id, { reason: `Already in the repo docs (${file}).`, provider: REPO_DOCS });
        return "in_docs";
      }
    }
    const near = options.near ?? (await memory.neighbours({ fact }, coveringScopes(fact.scope, task?.org)));
    const top = near[0];
    if (options.checkDuplicate && top !== undefined && top.cosine >= DUPLICATE_COSINE) {
      memory.merge(fact.id, top.fact.id, {
        reason: `Same as fact ${top.fact.id} (cosine ${top.cosine.toFixed(2)}), so no model was asked.`,
        confidence: top.cosine,
      });
      return "duplicate";
    }

    // The owner decides these without spending a model on them.
    const settings = await this.deps.settings();
    if (settings.review_all || fact.scope === "global") return "pending";

    const related = near.find(
      (n) => n.fact.status === "active" && n.cosine >= RELATED_COSINE && n.cosine < DUPLICATE_COSINE,
    );
    return this.decide(fact, related, settings.auto_threshold, options.review === true);
  }

  private async decide(
    fact: Fact,
    related: { fact: Fact; cosine: number } | undefined,
    threshold: number,
    review: boolean,
  ): Promise<Outcome> {
    const { memory, decisions } = this.deps;
    const result = await decisions
      .decide(request(fact, related?.fact), {
        use: "memory",
        ...(fact.task === undefined ? {} : { task: fact.task }),
        ...(fact.agent === undefined ? {} : { agent: fact.agent }),
      })
      .catch(() => undefined);
    if (result === undefined) {
      if (review) return "pending";
      memory.keep(fact.id, {
        reason:
          "Kept: no provider answered. Only global lessons and contradictions wait for you. Undo drops it.",
      });
      return "kept";
    }

    /**
     * The answer's probability when it passes majhi's gate and a stricter lift over chance for
     * memory (a wrong fact persists), else undefined. Lift, unlike a raw probability, means the same
     * for two and three options.
     */
    const sure = (a: Answer | undefined): number | undefined => {
      if (a === undefined || a.gate?.accepted !== true || a.gate.lift < threshold) return undefined;
      return a.probabilities?.[String(a.value)] ?? a.confidence;
    };
    const { worth, relation, private: secret } = result.answers;
    const note = (reason: string, confidence: number | undefined) => ({
      reason,
      ...(confidence === undefined ? {} : { confidence }),
      provider: result.provider,
    });
    const done = (text: string, outcome: Outcome): Outcome => {
      decisions.outcome(result.id, { text, fellBack: outcome === "pending" });
      return outcome;
    };

    // A suspected secret or personal data is never kept on its own, sure or not. Undo keeps it.
    if (secret?.value === true) {
      const p = sure(secret);
      memory.drop(
        fact.id,
        note(
          p === undefined
            ? "It may hold a secret or personal data. Undo keeps it."
            : "The provider found a secret or personal data in it.",
          p ?? secret.confidence,
        ),
      );
      return done("Dropped: secret or personal data.", "rejected");
    }
    const worthP = sure(worth);
    if (worth?.value === CHATTER && worthP !== undefined) {
      memory.drop(fact.id, note("Task chatter, not a lasting lesson.", worthP));
      return done("Dropped as task chatter.", "dropped");
    }
    if (related !== undefined) {
      // A contradiction always waits: the owner says which of the two holds.
      if (relation?.value === CONTRADICTS) {
        return done(`It may contradict fact ${related.fact.id}, so the owner decides.`, "pending");
      }
      const relationP = sure(relation);
      if (relation?.value === SAME && relationP !== undefined) {
        memory.merge(fact.id, related.fact.id, note(`Same as fact ${related.fact.id}.`, relationP));
        return done(`Merged into fact ${related.fact.id}.`, "duplicate");
      }
    }
    if (review) return done("Waits for the owner's review: inferred, not said by the owner.", "pending");
    const confident = worth?.value === KEEP && worthP !== undefined;
    memory.keep(
      fact.id,
      note(
        confident
          ? "A lasting lesson."
          : "Kept: not sure it is chatter. Only global lessons and contradictions wait for you. Undo drops it.",
        confident ? worthP : undefined,
      ),
    );
    return done("Kept: a lasting lesson.", "kept");
  }
}

/** The one call per candidate: the candidate and its nearest fact as state, three questions. */
export function request(fact: Fact, nearest: Fact | undefined): DecideRequestInput {
  return {
    state: {
      candidate: fact.text,
      ...(nearest === undefined ? {} : { nearest: nearest.text }),
    },
    questions: {
      worth: {
        type: "choice",
        instructions:
          "Is the candidate a lasting fact for later tasks in this scope (a convention, a command, a decision, a constraint), or chatter about the task it came from?",
        options: [
          { key: KEEP, description: "a lasting fact that will still hold in later tasks" },
          { key: CHATTER, description: "task chatter: status, a one-off detail, or only true for that task" },
        ],
      },
      ...(nearest === undefined
        ? {}
        : {
            relation: {
              type: "choice" as const,
              instructions: "Compared with the nearest fact, what does the candidate say?",
              options: [
                { key: SAME, description: "the same thing, in other words" },
                { key: CONTRADICTS, description: "it says the opposite, or replaces the nearest fact" },
                { key: UNRELATED, description: "a different point, which can stand beside it" },
              ],
            },
          }),
      private: {
        type: "noul" as const,
        instructions:
          "Does the candidate contain a secret (a key, token, password) or personal data (a name, email, phone)?",
        criteria: {
          true: "it holds a secret or personal data",
          false: "it holds neither",
        },
      },
    },
  };
}
