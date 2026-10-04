import {
  ABSTAIN,
  type Answer,
  type Calibration,
  type EvalMetrics,
  type Gate,
  type GateSettings,
  gateAnswer,
  type Question,
} from "@majhi/shared";
import { answerConfidence, applyTemperature, ordersAgree } from "./answers.ts";
import type { RawItem } from "./evalRunner.ts";
import { computeMetrics, type ScoredItem } from "./metrics.ts";
import { MIN_LABELS, READ_BY_HAND, type SlotDef } from "./slots.ts";

/** Answers the bar must let through on the part that picked it, before it counts as a bar. */
export const MIN_ACCEPTED_TO_PICK = 10;
/** Answers the bar must let through on the held-out part, before the slot may go live. */
export const MIN_ACCEPTED_TO_VERIFY = 5;

const EPS = 1e-4;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Probability mass per class, with the options an answer could name mapped through the slot's `classOf`. */
function classMass(
  probabilities: Readonly<Record<string, number>>,
  classOf: (v: string) => string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(probabilities)) out[classOf(k)] = (out[classOf(k)] ?? 0) + p;
  return out;
}

/** The temperature that makes the model's probabilities best explain the labels (lowest log loss). */
export function fitTemperature(
  items: readonly { probabilities: Readonly<Record<string, number>>; truth: string }[],
  classOf: (v: string) => string = (v) => v,
): number {
  if (items.length === 0) return 1;
  let best = 1;
  let bestLoss = Number.POSITIVE_INFINITY;
  // 0.25 to 6 in 60 steps, evenly spaced in the logarithm: both a sharpening and a strong flattening are in reach.
  for (let i = 0; i <= 60; i += 1) {
    const t = 0.25 * (6 / 0.25) ** (i / 60);
    let loss = 0;
    for (const item of items) {
      const mass = classMass(applyTemperature(item.probabilities, t), classOf);
      loss -= Math.log(Math.max(EPS, mass[item.truth] ?? 0));
    }
    if (loss < bestLoss - 1e-9) {
      bestLoss = loss;
      best = t;
    }
  }
  return best;
}

export interface Candidate {
  confidence: number;
  correct: boolean;
  /** False when the option orders disagreed: such an answer never counts, whatever its confidence. */
  agrees: boolean;
}

/**
 * The lowest bar on confidence at which the answers that clear it are right at least `target` of
 * the time, with at least `minAccepted` of them. Undefined when no bar does: nothing may act.
 */
export function chooseThreshold(
  candidates: readonly Candidate[],
  target: number,
  minAccepted = MIN_ACCEPTED_TO_PICK,
): number | undefined {
  const usable = candidates.filter((c) => c.agrees).sort((a, b) => b.confidence - a.confidence);
  let best: number | undefined;
  let right = 0;
  for (let i = 0; i < usable.length; i += 1) {
    const c = usable[i];
    if (c === undefined) continue;
    if (c.correct) right += 1;
    const next = usable[i + 1];
    // Only cut between two different confidences: a bar cannot split a tie.
    if (next !== undefined && next.confidence === c.confidence) continue;
    if (i + 1 >= minAccepted && right / (i + 1) >= target) best = c.confidence;
  }
  return best;
}

/** The base bar (lift and margin over the model's own probabilities) plus the rule that the option orders agree. */
export function baseGate(q: Question, a: Answer, settings: GateSettings): Gate {
  const g = gateAnswer(q, a, settings);
  if (g.accepted && ordersAgree(a) === false)
    return { ...g, accepted: false, reason: "the answer changed when the options were turned around" };
  return g;
}

/**
 * The bar once a slot is calibrated: the answer's calibrated confidence must reach the slot's
 * threshold, it must not be the abstain option, and every option order must name it.
 */
export function thresholdGate(
  q: Question,
  a: Answer,
  c: Pick<Calibration, "temperature" | "threshold">,
  settings: GateSettings,
): Gate {
  const base = gateAnswer(q, a, settings);
  const confidence = answerConfidence(a, c.temperature);
  const numbers = { lift: base.lift, margin: base.margin, confidence };
  if (q.type === "choice" && q.abstain && a.value === ABSTAIN.key)
    return { accepted: false, reason: "it said none of the options fits", ...numbers };
  if (ordersAgree(a) === false)
    return { accepted: false, reason: "the answer changed when the options were turned around", ...numbers };
  if (confidence < c.threshold)
    return {
      accepted: false,
      reason: `${confidence.toFixed(2)} sure, under the ${c.threshold.toFixed(2)} this decision needs`,
      ...numbers,
    };
  return {
    accepted: true,
    reason: `${confidence.toFixed(2)} sure, over the ${c.threshold.toFixed(2)} bar`,
    ...numbers,
  };
}

/** What the eval scores with: the slot's calibrated bar when it has one, else the base bar. Ignores the slot's mode. */
export function previewGate(
  q: Question,
  a: Answer,
  cal: Calibration | undefined,
  settings: GateSettings,
): Gate {
  return cal === undefined ? baseGate(q, a, settings) : thresholdGate(q, a, cal, settings);
}

/**
 * The gate the decision service puts on a Laya answer. A use that an agent or the owner reads
 * themselves keeps the base bar. Any other slot acts only when it is live: calibrated with a passing
 * eval on the model that is answering now, or started live by its definition. Otherwise the answer
 * is kept in the log as a shadow: it never counts, so the caller uses its safe default.
 */
export function liveGate(input: {
  slot: SlotDef;
  q: Question;
  a: Answer;
  cal: Calibration | undefined;
  settings: GateSettings;
  /** The checkpoint answering now; empty when unknown. */
  version: string;
  labels: number;
}): Gate {
  const { slot, q, a, cal, settings } = input;
  if (READ_BY_HAND.has(slot.use)) return baseGate(q, a, settings);
  const base = gateAnswer(q, a, settings);
  const shadow = (why: string): Gate => ({
    accepted: false,
    shadow: true,
    reason: `shadow: ${why}`,
    lift: base.lift,
    margin: base.margin,
    confidence: answerConfidence(a, cal?.temperature ?? 1),
  });
  if (cal === undefined) {
    if (slot.startMode === "live") return baseGate(q, a, settings);
    return shadow(
      input.labels < MIN_LABELS
        ? `${input.labels} of ${MIN_LABELS} labels so far, so it logs and acts on nothing`
        : "it has labels but no passing eval yet",
    );
  }
  if (cal.mode === "shadow") return shadow(cal.reason);
  if (input.version !== "" && cal.version !== input.version)
    return shadow(`the model changed from ${cal.version} to ${input.version}, so it needs a new eval`);
  return thresholdGate(q, a, cal, settings);
}

export interface FitOptions {
  now: () => Date;
  settings: GateSettings;
}

/**
 * Fits a slot's calibration from its labeled items. Three parts, by a fixed hash of the item, so a
 * rerun with the same items gives the same answer: 40% fit the temperature, 30% choose the bar for
 * the slot's target precision, and 30% are held out to check it. The slot goes live only when the
 * held-out part reaches the target with enough answers. Undefined with fewer than `MIN_LABELS` answered items.
 */
export function fitSlot(
  slot: SlotDef,
  items: readonly RawItem[],
  version: string,
  options: FitOptions,
): { calibration: Calibration; heldOut: EvalMetrics } | undefined {
  const classOf = slot.classOf ?? ((v: string) => v);
  const answered = items.filter((i): i is RawItem & { answer: Answer } => i.answer !== undefined);
  if (answered.length < MIN_LABELS) return undefined;
  const part = (i: RawItem) => hash(i.id) % 10;
  const fitPart = answered.filter((i) => part(i) <= 3);
  const pickPart = answered.filter((i) => part(i) >= 4 && part(i) <= 6);
  const heldPart = answered.filter((i) => part(i) >= 7);

  const temperature = fitTemperature(
    fitPart.map((i) => ({
      probabilities: i.answer.probabilities ?? { [String(i.answer.value)]: i.answer.confidence },
      truth: i.truth,
    })),
    classOf,
  );
  const candidate = (i: RawItem & { answer: Answer }): Candidate => ({
    confidence: answerConfidence(i.answer, temperature),
    correct:
      classOf(String(i.answer.value)) === i.truth &&
      !(i.question.type === "choice" && i.question.abstain && i.answer.value === ABSTAIN.key),
    agrees: ordersAgree(i.answer) !== false,
  });
  const threshold = chooseThreshold(pickPart.map(candidate), slot.target);
  const bar = threshold ?? 1.01;

  const scoreHeld = (list: typeof heldPart): ScoredItem[] =>
    list.map((i) => {
      const c = candidate(i);
      const abstained = i.question.type === "choice" && i.question.abstain && i.answer.value === ABSTAIN.key;
      return {
        truth: i.truth,
        predicted: abstained ? undefined : classOf(String(i.answer.value)),
        confidence: c.confidence,
        accepted: c.agrees && !abstained && c.confidence >= bar,
        latencyMs: i.latencyMs,
        consistent: i.consistent,
      };
    });
  const heldOut = computeMetrics(scoreHeld(heldPart));
  const accepted = heldOut.coverage * heldOut.n;
  const passes =
    threshold !== undefined &&
    heldOut.precision !== null &&
    heldOut.precision >= slot.target &&
    accepted >= MIN_ACCEPTED_TO_VERIFY;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const reason =
    threshold === undefined
      ? `No bar reaches ${pct(slot.target)} precision on ${answered.length} labels, so it stays in shadow.`
      : passes
        ? `Live: held-out precision ${pct(heldOut.precision ?? 0)} at ${pct(heldOut.coverage)} coverage over ${heldPart.length} labels (target ${pct(slot.target)}).`
        : `Shadow: the bar held ${heldOut.precision === null ? "no answers" : pct(heldOut.precision)} precision on ${heldPart.length} held-out labels (target ${pct(slot.target)}).`;
  return {
    calibration: {
      slot: slot.id,
      mode: passes ? "live" : "shadow",
      temperature,
      threshold: Math.min(1, bar),
      target: slot.target,
      heldOutPrecision: heldOut.precision,
      heldOutCoverage: heldOut.coverage,
      labels: answered.length,
      version,
      fittedAt: options.now().toISOString(),
      reason,
    },
    heldOut,
  };
}
