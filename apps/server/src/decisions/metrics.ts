import type { ClassMetric, EvalMetrics } from "@majhi/shared";

/** One labeled item after the provider answered it. */
export interface ScoredItem {
  /** The right answer. */
  truth: string;
  /** The class the answer counts as, or undefined when the provider failed or abstained. */
  predicted: string | undefined;
  /** The answer's confidence after any calibration. */
  confidence: number;
  /** Whether the gate lets the answer act. */
  accepted: boolean;
  latencyMs: number;
  /** Whether two option orders gave the same option; undefined when the item was asked in one order only. */
  consistent?: boolean | undefined;
  /** The provider threw or never answered. */
  failed?: boolean;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

/** The nearest-rank percentile of a list, null when it is empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

/**
 * Expected calibration error: the confidence of each answer against how often answers at that
 * confidence were right, over ten equal bins, weighted by how many answers fall in each.
 */
export function expectedCalibrationError(
  items: readonly Pick<ScoredItem, "confidence" | "truth" | "predicted">[],
): number | null {
  const answered = items.filter((i) => i.predicted !== undefined);
  if (answered.length === 0) return null;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, confidence: 0, correct: 0 }));
  for (const i of answered) {
    const bin = bins[Math.min(9, Math.floor(i.confidence * 10))];
    if (bin === undefined) continue;
    bin.n += 1;
    bin.confidence += i.confidence;
    if (i.predicted === i.truth) bin.correct += 1;
  }
  return bins.reduce(
    (sum, b) =>
      sum + (b.n === 0 ? 0 : (b.n / answered.length) * Math.abs(b.confidence / b.n - b.correct / b.n)),
    0,
  );
}

/**
 * Everything the eval reports for a set of scored items. Per-class recall shows a one-class
 * collapse (a provider that always says "large" has recall 0 for the rest), the majority baseline
 * says what a no-skill answer scores, and precision with coverage say what the gate buys.
 */
export function computeMetrics(items: readonly ScoredItem[], costPer1000Usd = 0): EvalMetrics {
  const answered = items.filter((i) => !i.failed);
  const withAnswer = answered.filter((i) => i.predicted !== undefined);
  const correct = withAnswer.filter((i) => i.predicted === i.truth).length;
  const truths = new Map<string, number>();
  for (const i of answered) truths.set(i.truth, (truths.get(i.truth) ?? 0) + 1);
  const classes = [
    ...new Set([
      ...truths.keys(),
      ...withAnswer.flatMap((i) => (i.predicted === undefined ? [] : [i.predicted])),
    ]),
  ].sort();
  const perClass: ClassMetric[] = classes.map((label) => {
    const support = truths.get(label) ?? 0;
    const hit = answered.filter((i) => i.truth === label && i.predicted === label).length;
    const said = withAnswer.filter((i) => i.predicted === label);
    return {
      label,
      support,
      recall: ratio(hit, support),
      precision: ratio(said.filter((i) => i.truth === label).length, said.length),
    };
  });
  const accepted = answered.filter((i) => i.accepted && i.predicted !== undefined);
  const twice = answered.filter((i) => i.consistent !== undefined);
  const latencies = items.map((i) => i.latencyMs);
  return {
    n: answered.length,
    failed: items.length - answered.length,
    accuracy: ratio(correct, answered.length),
    majorityBaseline: ratio(Math.max(0, ...truths.values()), answered.length),
    perClass,
    precision: ratio(accepted.filter((i) => i.predicted === i.truth).length, accepted.length),
    coverage: answered.length === 0 ? 0 : accepted.length / answered.length,
    ece: expectedCalibrationError(answered),
    orderConsistency: ratio(twice.filter((i) => i.consistent).length, twice.length),
    latencyP50Ms: percentile(latencies, 50),
    latencyP90Ms: percentile(latencies, 90),
    costPer1000Usd,
  };
}
