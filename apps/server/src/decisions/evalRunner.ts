import {
  ABSTAIN,
  type Answer,
  type Calibration,
  type ChoiceQuestion,
  type DecideRequest,
  DecideRequestSchema,
  type DecisionLabel,
  type EvalMetrics,
  type EvalReport,
  type EvalSet,
  type Gate,
  type Question,
} from "@majhi/shared";
import { ordersAgree } from "./answers.ts";
import type { EvalStore } from "./evalStore.ts";
import type { LabelStore } from "./labels.ts";
import type { DecisionLog } from "./log.ts";
import { computeMetrics, type ScoredItem } from "./metrics.ts";
import { MIN_LABELS, type SlotDef, type SlotRegistry } from "./slots.ts";

/** What the harness asks: a provider reduced to "answer this request", with the facts a report needs. */
export interface EvalProvider {
  id: string;
  version(): string;
  /** Money per 1,000 decisions. Zero for Laya. */
  costPer1000Usd: number;
  ask(request: DecideRequest): Promise<Record<string, Answer>>;
}

/** An item after the provider answered, before any gate or calibration is applied. */
export interface RawItem {
  /** The decision's id for a labeled item, `fixture-<n>` for a fixture. */
  id: string;
  question: Question;
  truth: string;
  answer: Answer | undefined;
  latencyMs: number;
  consistent: boolean | undefined;
}

/** Fits a slot's calibration from its labeled items; undefined when the items cannot support one. */
export type Fitter = (
  slot: SlotDef,
  items: readonly RawItem[],
  version: string,
) => { calibration: Calibration; heldOut: EvalMetrics } | undefined;

export interface CalibrationBook {
  get(slot: string): Calibration | undefined;
  save(calibration: Calibration): void;
}

export interface RunnerDeps {
  registry: SlotRegistry;
  labels: LabelStore;
  log: DecisionLog;
  results: EvalStore;
  provider: EvalProvider;
  /** The gate for a slot, with its calibration when it has one. The eval and the live path use the same one. */
  gate: (slot: SlotDef, q: Question, a: Answer, calibration: Calibration | undefined) => Gate;
  calibrations?: CalibrationBook | undefined;
  fit?: Fitter | undefined;
  now?: () => Date;
  /** The newest this many labels are used. */
  maxItems?: number;
  concurrency?: number;
  /** One answer may take this long; then the item counts as failed. */
  itemTimeoutMs?: number;
}

const OWNER_FIRST: Record<DecisionLabel["source"], number> = { owner: 0, teacher: 1, outcome: 2 };

/** The label that counts for each decision and question: the owner's, else a teacher's, else an outcome's. */
export function bestLabels(labels: readonly DecisionLabel[]): DecisionLabel[] {
  const best = new Map<string, DecisionLabel>();
  for (const l of labels) {
    const key = `${l.decisionId}\u0000${l.question}`;
    const have = best.get(key);
    if (have === undefined || OWNER_FIRST[l.source] < OWNER_FIRST[have.source]) best.set(key, l);
  }
  return [...best.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** A choice with its options in the order given, or reversed, asked once. The abstain option stays last. */
function once(request: DecideRequest, key: string, q: ChoiceQuestion, reverse: boolean): DecideRequest {
  const options = reverse ? [...q.options].reverse() : q.options;
  return DecideRequestSchema.parse({
    state: request.state,
    questions: { [key]: { ...q, options, orders: "once" } },
  });
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Runs a slot's labeled set or built-in fixtures through the provider and reports how it does (5.12).
 * It goes through the same request, the same provider call and the same gate as production, and
 * touches no running task. Nothing here talks to a model other than the provider it is given, so
 * tests run it against a fake.
 */
export class EvalRunner {
  private readonly now: () => Date;
  /** A run in progress, so two clicks (or two callers) share one run instead of racing. */
  private readonly running = new Map<string, Promise<EvalReport>>();

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  run(slotId: string, set: EvalSet): Promise<EvalReport> {
    const key = `${slotId}\u0000${set}`;
    const going = this.running.get(key);
    if (going !== undefined) return going;
    const slot = this.deps.registry.byId(slotId);
    if (slot === undefined) return Promise.reject(new Error(`There is no decision slot ${slotId}.`));
    const work = this.execute(slot, set).finally(() => this.running.delete(key));
    this.running.set(key, work);
    return work;
  }

  private async execute(slot: SlotDef, set: EvalSet): Promise<EvalReport> {
    const { provider } = this.deps;
    const raw = await this.collect(slot, set);
    let calibration = this.deps.calibrations?.get(slot.id);
    let heldOut: EvalMetrics | undefined;
    if (set === "labels" && this.deps.fit !== undefined && raw.length >= MIN_LABELS) {
      const fitted = this.deps.fit(slot, raw, provider.version());
      if (fitted !== undefined) {
        calibration = fitted.calibration;
        heldOut = fitted.heldOut;
        this.deps.calibrations?.save(fitted.calibration);
      }
    }
    const report = this.deps.results.add({
      slot: slot.id,
      title: slot.title,
      set,
      at: this.now().toISOString(),
      provider: provider.id,
      version: provider.version(),
      metrics: computeMetrics(this.score(slot, raw, calibration), provider.costPer1000Usd),
      ...(heldOut === undefined ? {} : { heldOut }),
      ...(calibration === undefined ? {} : { calibration }),
    });
    return report;
  }

  /** The raw items, scored with the slot's gate and calibration. */
  score(slot: SlotDef, raw: readonly RawItem[], calibration: Calibration | undefined): ScoredItem[] {
    return raw.map((item) => {
      const a = item.answer;
      if (a === undefined)
        return {
          truth: item.truth,
          predicted: undefined,
          confidence: 0,
          accepted: false,
          latencyMs: item.latencyMs,
          failed: true,
        };
      const gate = this.deps.gate(slot, item.question, a, calibration);
      const value = String(a.value);
      const abstained = item.question.type === "choice" && item.question.abstain && value === ABSTAIN.key;
      return {
        truth: item.truth,
        predicted: abstained ? undefined : (slot.classOf?.(value) ?? value),
        confidence: gate.confidence ?? a.confidence,
        accepted: gate.accepted,
        latencyMs: item.latencyMs,
        consistent: item.consistent,
      };
    });
  }

  /** Asks the provider every item of the set, a few at a time. */
  async collect(slot: SlotDef, set: EvalSet): Promise<RawItem[]> {
    const items = set === "fixtures" ? this.fixtureItems(slot) : this.labeledItems(slot);
    const out: RawItem[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < items.length; i = next++) {
        const item = items[i];
        if (item !== undefined) out[i] = await this.ask(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.deps.concurrency ?? 4, items.length) }, worker));
    return out;
  }

  private fixtureItems(slot: SlotDef) {
    return (slot.fixtures?.() ?? []).flatMap((f, n) => {
      const request = DecideRequestSchema.safeParse(f.request);
      const q = request.success ? request.data.questions[f.question] : undefined;
      return request.success && q !== undefined
        ? [{ id: `fixture-${n + 1}`, request: request.data, key: f.question, q, truth: f.label }]
        : [];
    });
  }

  private labeledItems(slot: SlotDef) {
    const all = this.deps.labels.forUse(slot.use).filter((l) => this.deps.registry.has(slot, l));
    const newest = bestLabels(all).slice(-(this.deps.maxItems ?? 300));
    return newest.flatMap((l) => {
      const stored = this.deps.log.get(l.decisionId)?.request;
      if (stored === undefined) return [];
      const request = DecideRequestSchema.safeParse({ state: stored.state, questions: stored.questions });
      const q = request.success ? request.data.questions[l.question] : undefined;
      return request.success && q !== undefined
        ? [{ id: l.decisionId, request: request.data, key: l.question, q, truth: l.label }]
        : [];
    });
  }

  private async ask(item: {
    id: string;
    request: DecideRequest;
    key: string;
    q: Question;
    truth: string;
  }): Promise<RawItem> {
    const { provider } = this.deps;
    const limit = this.deps.itemTimeoutMs ?? 30_000;
    const started = performance.now();
    try {
      const answers = await withTimeout(provider.ask(item.request), limit);
      const latencyMs = Math.round(performance.now() - started);
      const answer = answers[item.key];
      return {
        id: item.id,
        question: item.q,
        truth: item.truth,
        answer,
        latencyMs,
        consistent: answer === undefined ? undefined : await this.consistent(item, answer, limit),
      };
    } catch {
      return {
        id: item.id,
        question: item.q,
        truth: item.truth,
        answer: undefined,
        latencyMs: Math.round(performance.now() - started),
        consistent: undefined,
      };
    }
  }

  /** Whether the answer survives the options being turned around. A failed second ask is no evidence. */
  private async consistent(
    item: { request: DecideRequest; key: string; q: Question },
    answer: Answer,
    limit: number,
  ): Promise<boolean | undefined> {
    if (item.q.type === "noul") return ordersAgree(answer);
    if (item.q.type !== "choice") return undefined;
    const { provider } = this.deps;
    try {
      const [forward, reverse] = await Promise.all([
        withTimeout(provider.ask(once(item.request, item.key, item.q, false)), limit),
        withTimeout(provider.ask(once(item.request, item.key, item.q, true)), limit),
      ]);
      const a = forward[item.key];
      const b = reverse[item.key];
      return a === undefined || b === undefined ? undefined : String(a.value) === String(b.value);
    } catch {
      return undefined;
    }
  }
}
