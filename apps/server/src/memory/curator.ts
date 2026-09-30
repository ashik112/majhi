import {
  type Answer,
  type DecideRequestInput,
  type Fact,
  type MemoryExtractOutput,
  type MemoryScope,
  type MemorySettings,
  orgScope,
  parseScope,
  projectScope,
} from "@majhi/shared";
import type { Decisions } from "../decisions/api.ts";
import { errorMessage } from "../errors.ts";
import type { Candidate } from "./housekeeper.ts";
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
  /** Every project of the task's repos. */
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
}

export const EMPTY_COUNTS: MemoryExtractOutput = {
  candidates: 0,
  pending: 0,
  kept: 0,
  dropped: 0,
  duplicates: 0,
  rejected: 0,
};

type Outcome = "pending" | "kept" | "dropped" | "duplicate" | "rejected";

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
 * Curation (SPEC 5.6, Phase 5 Part B): what happens to a fact after an agent proposed it or the
 * Housekeeper wrote it. Every step is logged with its reason, confidence and provider, and can be
 * undone; nothing is deleted.
 *
 * 1. Rules: a secret or personal data is rejected, whatever a model would say.
 * 2. Duplicates, without a model: cosine 0.92 or more with an active or pending fact in the same
 *    or a wider scope. The candidate is the same fact.
 * 3. Decide, one call on the decision provider: lasting fact or chatter; against the nearest fact
 *    (cosine 0.75 to 0.92) the same, contradicting or unrelated; secret or personal data.
 * 4. Apply: an answer that counts and is at least `auto_threshold` sure is acted on; the rest wait
 *    for the owner. `review_all` and a global scope always wait.
 */
export class Curator {
  constructor(private readonly deps: CuratorDeps) {}

  /** An agent's proposal, already stored as pending. Never throws: the fact stays pending. */
  async curate(fact: Fact): Promise<void> {
    try {
      await this.run(fact, { checkDuplicate: true });
    } catch (err) {
      console.error(`Memory curation of fact ${fact.id} failed: ${errorMessage(err)}`);
    }
  }

  /** The Housekeeper's candidates for a task, each stored and curated. Resolves what happened to them. */
  async curateCandidates(
    task: CurationTask,
    candidates: readonly Candidate[],
    agent: string,
  ): Promise<MemoryExtractOutput> {
    const counts = { ...EMPTY_COUNTS, candidates: candidates.length };
    const allowed = await this.deps.allowed(task);
    const fallback: MemoryScope = task.org === undefined ? "global" : orgScope(task.org);
    for (const candidate of candidates) {
      // A scope the task's agents may not use is not honoured: the fact goes to the task's org.
      const scope = allowed.includes(candidate.scope) ? candidate.scope : fallback;
      let outcome: Outcome = "pending";
      try {
        outcome = await this.candidate(task, { text: candidate.text, scope }, agent);
      } catch (err) {
        console.error(`Memory curation of a candidate failed: ${errorMessage(err)}`);
      }
      if (outcome === "kept") counts.kept += 1;
      else if (outcome === "dropped") counts.dropped += 1;
      else if (outcome === "duplicate") counts.duplicates += 1;
      else if (outcome === "rejected") counts.rejected += 1;
      else counts.pending += 1;
    }
    return counts;
  }

  private async candidate(
    task: CurationTask,
    candidate: { text: string; scope: MemoryScope },
    agent: string,
  ): Promise<Outcome> {
    const { memory } = this.deps;
    // What the rules forbid is not stored at all, not even as a rejected row.
    if (forbiddenReason(candidate.text) !== undefined) return "rejected";
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
    const fact = await memory.addCandidate({ ...candidate, task: task.id, agent });
    return this.run(fact, { checkDuplicate: false, near });
  }

  private async run(
    fact: Fact,
    options: { checkDuplicate: boolean; near?: { fact: Fact; cosine: number }[] },
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
    return this.decide(fact, related, settings.auto_threshold);
  }

  private async decide(
    fact: Fact,
    related: { fact: Fact; cosine: number } | undefined,
    threshold: number,
  ): Promise<Outcome> {
    const { memory, decisions } = this.deps;
    const result = await decisions
      .decide(request(fact, related?.fact), {
        use: "memory",
        ...(fact.task === undefined ? {} : { task: fact.task }),
        ...(fact.agent === undefined ? {} : { agent: fact.agent }),
      })
      .catch(() => undefined);
    if (result === undefined) return "pending";

    /** The answer's probability when it counts and reaches the threshold, else undefined. */
    const sure = (a: Answer | undefined): number | undefined => {
      if (a === undefined || a.gate?.accepted !== true) return undefined;
      const p = a.probabilities?.[String(a.value)] ?? a.confidence;
      return p >= threshold ? p : undefined;
    };
    const { worth, relation, private: secret } = result.answers;
    const note = (reason: string, confidence: number) => ({
      reason,
      confidence,
      provider: result.provider,
    });
    const done = (text: string, outcome: Outcome): Outcome => {
      decisions.outcome(result.id, { text, fellBack: outcome === "pending" });
      return outcome;
    };

    // A model that suspects a secret or personal data never lets the fact in on its own.
    if (secret?.value === true) {
      const p = sure(secret);
      if (p === undefined)
        return done("It may hold a secret or personal data, so the owner decides.", "pending");
      memory.drop(fact.id, note("The provider found a secret or personal data in it.", p));
      return done("Dropped: secret or personal data.", "rejected");
    }
    const notPrivate = sure(secret);
    const worthP = sure(worth);
    if (worthP === undefined || worth?.value === undefined) {
      return done("Not sure enough whether it is worth keeping, so the owner decides.", "pending");
    }
    if (worth.value === CHATTER) {
      memory.drop(fact.id, note("Task chatter, not a lasting fact.", worthP));
      return done("Dropped as task chatter.", "dropped");
    }
    if (worth.value !== KEEP || notPrivate === undefined) {
      return done("Not sure enough it holds no secret or personal data, so the owner decides.", "pending");
    }

    if (related === undefined) {
      memory.keep(fact.id, note("A lasting fact.", Math.min(worthP, notPrivate)));
      return done("Kept: a lasting fact.", "kept");
    }
    const relationP = sure(relation);
    const floor = Math.min(worthP, notPrivate, relationP ?? 1);
    if (relationP === undefined) {
      return done(`Not sure how it relates to fact ${related.fact.id}, so the owner decides.`, "pending");
    }
    switch (relation?.value) {
      case SAME:
        memory.merge(fact.id, related.fact.id, {
          ...note(`Same as fact ${related.fact.id}.`, relationP),
        });
        return done(`Merged into fact ${related.fact.id}.`, "duplicate");
      case UNRELATED:
        memory.keep(fact.id, note("A lasting fact, apart from the nearest one.", floor));
        return done("Kept: a lasting fact.", "kept");
      case CONTRADICTS: {
        // A narrower fact never retires a wider one, and global facts are the owner's alone.
        if (related.fact.scope !== fact.scope || fact.scope === "global") {
          return done(
            `It contradicts fact ${related.fact.id}, which is wider than it, so the owner decides.`,
            "pending",
          );
        }
        memory.keep(fact.id, note(`A lasting fact. It replaces fact ${related.fact.id}.`, floor));
        memory.retire(related.fact.id, note(`Contradicted by fact ${fact.id}.`, relationP));
        return done(`Kept, and retired fact ${related.fact.id} that it contradicts.`, "kept");
      }
      default:
        return done("No clear relation to the nearest fact, so the owner decides.", "pending");
    }
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

/** Scopes a Housekeeper may write to for a task, as prompt text. */
export function scopeChoices(task: CurationTask): { scope: MemoryScope; meaning: string }[] {
  return [
    ...task.projects.map((p) => ({
      scope: projectScope(p),
      meaning: `only true in the repo ${p}`,
    })),
    ...(task.org === undefined
      ? []
      : [{ scope: orgScope(task.org), meaning: "true across this org's repos and work" }]),
    { scope: "global" as MemoryScope, meaning: "true everywhere, for every org (rare)" },
  ];
}
