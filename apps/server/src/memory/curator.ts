import {
  type Answer,
  type DecideRequestInput,
  type Fact,
  type MemoryExtractOutput,
  type MemoryScope,
  type MemorySettings,
  orgScope,
  type ProviderId,
  parseScope,
} from "@majhi/shared";
import type { Decisions } from "../decisions/api.ts";
import { errorMessage } from "../errors.ts";
import { escalateReview, unsureQuestions } from "./escalate.ts";
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
  decisions: Pick<Decisions, "decide" | "outcome" | "link" | "teach">;
  /**
   * Where a review that Laya is unsure about goes next: the smallest model that is set up answers once,
   * `perDay` times a day at most. Absent: the fact waits for the owner, as before.
   */
  escalate?: { perDay: number } | undefined;
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
const ASK = "ask";
/** What a review drops, by the kind the provider sorted the fact into, and the reason the log shows. */
const DROP_REASON: Readonly<Record<string, string>> = {
  "one-off": "a one-off symptom of one task",
  generic: "generic advice",
  majhi: "restates how majhi itself works",
  flaky: "a flaky or timing note",
};

/**
 * Whether an answer is firm enough to act on in a review: majhi's gate accepted it, or the provider's
 * own top probability is at least one half. A review leans toward deciding, because a fact left
 * waiting costs the owner a decision; the step is logged with its confidence and can be undone.
 */
function counts(a: Answer): boolean {
  return a.gate?.accepted === true || a.confidence >= 0.5;
}

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
 * 4. `review_all` and a global scope wait for the owner, without a model. The captain's memory
 *    chore in Private decides global facts too (`upkeep`).
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

  /**
   * An agent's proposal, already stored as pending. Never throws: the fact stays pending.
   * `upkeep`: the captain's memory chore asks, in Private's lane for a global fact, so a global fact
   * is decided like any other instead of waiting for the owner.
   */
  async curate(fact: Fact, options: { upkeep?: boolean } = {}): Promise<void> {
    try {
      await this.run(fact, { checkDuplicate: true, upkeep: options.upkeep === true });
    } catch (err) {
      console.error(`Memory curation of fact ${fact.id} failed: ${errorMessage(err)}`);
    }
  }

  /**
   * The captain's memory review (SPEC 5.18, Memory): one fact that waits, decided with a real bar so
   * the owner is left only the judgment calls. In order: the rules, the repo docs, a near copy
   * (cosine 0.92 or more, no model), then one call that sorts the fact into a kind. Only a durable,
   * non-obvious fact for later tasks is kept. A one-off symptom, generic advice, a restatement of how
   * majhi works and a flaky or timing note are dropped; the same point as another fact is merged into
   * it. A fact that contradicts another, or that would change how agents behave broadly, and any
   * fact the provider cannot sort, wait for the owner. Every step names its reason and can be undone.
   * Never throws: the fact stays pending. `reason` is the short phrase the captain's log shows.
   */
  async review(fact: Fact, options: { off?: ReadonlySet<string> } = {}): Promise<{ reason?: string }> {
    try {
      return await this.reviewOne(fact, options.off ?? new Set());
    } catch (err) {
      console.error(`Memory review of fact ${fact.id} failed: ${errorMessage(err)}`);
      return {};
    }
  }

  private async reviewOne(fact: Fact, off: ReadonlySet<string>): Promise<{ reason?: string }> {
    const { memory, decisions } = this.deps;
    // The owner's switches (the Memory playbook): an action that is off leaves the memory waiting for the owner.
    const noDrop = off.has("mem-drop")
      ? { reason: "dropping and merging memories is switched off" }
      : undefined;
    const noKeep = off.has("mem-keep") ? { reason: "keeping memories is switched off" } : undefined;
    const task = fact.task === undefined ? undefined : this.deps.task(fact.task);
    const rule = forbiddenReason(fact.text);
    if (rule !== undefined) {
      if (noDrop !== undefined) return noDrop;
      memory.drop(fact.id, {
        reason: `${rule} Facts never hold secrets or personal data.`,
        provider: "rules",
      });
      return { reason: "it holds a secret or personal data" };
    }
    const file = await this.deps.inDocs?.(task, fact.text);
    if (file !== undefined) {
      if (noDrop !== undefined) return noDrop;
      const reason = `already in the repo docs (${file})`;
      memory.drop(fact.id, { reason, provider: REPO_DOCS });
      return { reason };
    }
    const near = (await memory.neighbours({ fact }, coveringScopes(fact.scope, task?.org))).filter(
      (n) => n.fact.id !== fact.id && (n.fact.status === "active" || n.fact.status === "pending"),
    );
    const top = near[0];
    if (top !== undefined && top.cosine >= DUPLICATE_COSINE) {
      if (noDrop !== undefined) return noDrop;
      const reason = `the same as fact ${top.fact.id}`;
      memory.merge(fact.id, top.fact.id, { reason, confidence: top.cosine });
      return { reason };
    }
    const settings = await this.deps.settings();
    if (settings.review_all) return { reason: "you review every memory" };
    const related = near.find((n) => n.cosine >= RELATED_COSINE && n.cosine < DUPLICATE_COSINE);
    const result = await decisions
      .decide(reviewRequest(fact, related?.fact), {
        use: "memory",
        ...(fact.task === undefined ? {} : { task: fact.task }),
        ...(fact.agent === undefined ? {} : { agent: fact.agent }),
      })
      .catch(() => undefined);
    // No answer: nothing is kept or dropped on a guess; the fact keeps waiting.
    if (result === undefined) return { reason: "no provider answered" };
    decisions.link?.("memory", String(fact.id), result.id, "verdict");
    let { verdict, relation, private: secret } = result.answers;
    // Laya was not sure: the smallest model that is set up reads it once, within the day's budget, so the
    // owner is left only with what still nobody can settle. Down or out of budget: it waits, as before.
    const via = new Map<Answer, ProviderId>();
    const unsure =
      this.deps.escalate === undefined || off.has("mem-escalate")
        ? []
        : unsureQuestions(result.answers, counts, related !== undefined);
    if (this.deps.escalate !== undefined && unsure.length > 0) {
      const up = await escalateReview(decisions, reviewRequest(fact, related?.fact), unsure, counts, {
        perDay: this.deps.escalate.perDay,
        task: fact.task,
        agent: fact.agent,
      });
      if (up !== undefined) {
        for (const a of Object.values(up.answers)) via.set(a, up.provider);
        if (up.answers.verdict !== undefined) verdict = up.answers.verdict;
        if (up.answers.relation !== undefined) relation = up.answers.relation;
        if (up.answers.private !== undefined) secret = up.answers.private;
        decisions.outcome(up.decision, { text: "Escalated from Laya, which was not sure.", fellBack: false });
        // The stand-in's answer is a teacher's label on Laya's own decision.
        for (const name of Object.keys(up.answers)) {
          const a = up.answers[name as keyof typeof up.answers];
          if (a !== undefined)
            decisions.teach?.(
              result.id,
              name,
              String(a.value),
              `${up.provider} answered where Laya was unsure`,
            );
        }
      }
    }
    const note = (reason: string, a: Answer | undefined) => ({
      reason,
      ...(a === undefined ? {} : { confidence: a.confidence }),
      provider: (a === undefined ? undefined : via.get(a)) ?? result.provider,
    });
    const done = (text: string, reason: string, fellBack = false) => {
      decisions.outcome(result.id, { text, fellBack });
      return { reason };
    };
    if (secret?.value === true && counts(secret)) {
      if (noDrop !== undefined) return noDrop;
      const reason = "it may hold a secret or personal data";
      memory.drop(fact.id, note(reason, secret));
      return done("Dropped: secret or personal data.", reason);
    }
    if (related !== undefined && relation !== undefined && counts(relation)) {
      if (relation.value === CONTRADICTS) {
        const reason = `it may contradict fact ${related.fact.id}`;
        return done(`It may contradict fact ${related.fact.id}, so the owner decides.`, reason, true);
      }
      if (relation.value === SAME) {
        if (noDrop !== undefined) return noDrop;
        const reason = `the same point as fact ${related.fact.id}`;
        memory.merge(fact.id, related.fact.id, note(reason, relation));
        return done(`Merged into fact ${related.fact.id}.`, reason);
      }
    }
    const kind = verdict !== undefined && counts(verdict) ? String(verdict.value) : undefined;
    if (kind === undefined) return done("Waits for the owner: not sure.", "not sure what it is", true);
    if (kind === ASK) {
      return done("Waits for the owner: a judgment call.", "it would change how agents behave broadly", true);
    }
    if (kind === KEEP) {
      if (noKeep !== undefined) return noKeep;
      const reason = "a durable fact for later tasks";
      memory.keep(fact.id, note(reason, verdict));
      return done("Kept: a durable fact.", reason);
    }
    const why = DROP_REASON[kind];
    if (why === undefined) return done("Waits for the owner: unknown kind.", "not sure what it is", true);
    if (noDrop !== undefined) return noDrop;
    memory.drop(fact.id, note(why, verdict));
    return done(`Dropped: ${why}.`, why);
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
    const outcome = await this.run(fact, { checkDuplicate: false, near, docsChecked: true, review: true });
    if (outcome === "pending") memory.waiting(fact);
    return outcome;
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
      upkeep?: boolean;
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

    // The owner decides these without spending a model on them. A global fact waits for the
    // captain's upkeep in Private when it is not the one asking.
    const settings = await this.deps.settings();
    if (settings.review_all || (fact.scope === "global" && options.upkeep !== true)) return "pending";

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

    decisions.link?.("memory", String(fact.id), result.id, "worth");

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

/**
 * The review's one call per fact: what kind of fact it is (and so whether it is kept, dropped or left
 * for the owner), how it relates to the nearest fact, and whether it holds a secret.
 */
export function reviewRequest(fact: Fact, nearest: Fact | undefined): DecideRequestInput {
  return {
    state: {
      candidate: fact.text,
      scope: fact.scope,
      ...(nearest === undefined ? {} : { nearest: nearest.text }),
    },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "A memory is kept only if it is a durable, non-obvious fact that will help a future task in this scope and cannot be read from the code or docs. Most candidates are not. Sort the candidate.",
        options: [
          {
            key: KEEP,
            description:
              "durable and non-obvious: a convention, a command, a decision or a constraint that will still hold",
          },
          {
            key: "one-off",
            description: "a symptom, incident, bug report or log of one task, true only for that moment",
          },
          {
            key: "generic",
            description: "generic advice any engineer already knows, like checking before acting",
          },
          {
            key: "majhi",
            description: "a restatement of how majhi itself, its agents, rooms, worktrees or cards behave",
          },
          { key: "flaky", description: "a flaky test, a timing or environment note" },
          {
            key: ASK,
            description:
              "a genuine judgment call: it would change how agents behave in many tasks, or conflicts with the owner's instructions",
          },
        ],
      },
      ...(nearest === undefined
        ? {}
        : {
            relation: {
              type: "choice" as const,
              instructions: "Compared with the nearest fact, what does the candidate say?",
              options: [
                { key: SAME, description: "the same point, in other words" },
                { key: CONTRADICTS, description: "it says the opposite, or replaces the nearest fact" },
                { key: UNRELATED, description: "a different point, which can stand beside it" },
              ],
            },
          }),
      private: {
        type: "noul" as const,
        instructions:
          "Does the candidate contain a secret (a key, token, password) or personal data (a name, email, phone)?",
        criteria: { true: "it holds a secret or personal data", false: "it holds neither" },
      },
    },
  };
}
