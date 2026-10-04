import type { Answer } from "@majhi/shared";

/** The key with the highest probability. Ties go to the first. */
export function topKey(probabilities: Readonly<Record<string, number>>): string | undefined {
  let best: string | undefined;
  let bestP = -1;
  for (const [k, p] of Object.entries(probabilities)) {
    if (p > bestP) {
      best = k;
      bestP = p;
    }
  }
  return best;
}

/**
 * Whether every option order named the answer. Undefined when the answer came from one run, which
 * cannot be checked. A run with no probabilities counts as disagreeing.
 */
export function ordersAgree(a: Answer): boolean | undefined {
  if (a.runs === undefined || a.runs.length < 2) return undefined;
  const value = String(a.value);
  return a.runs.every((run) => topKey(run) === value);
}

/**
 * Probabilities raised to 1/temperature and renormalized. A temperature above 1 flattens an
 * over-confident model, one below 1 sharpens it; 1 changes nothing. Garbage in (negative, NaN,
 * all zero) gives an even spread, so a broken provider can never look sure.
 */
export function applyTemperature(
  probabilities: Readonly<Record<string, number>>,
  temperature: number,
): Record<string, number> {
  const keys = Object.keys(probabilities);
  if (keys.length === 0) return {};
  const t = Number.isFinite(temperature) && temperature > 0 ? temperature : 1;
  const raised = keys.map((k) => {
    const p = probabilities[k] ?? 0;
    return Number.isFinite(p) && p > 0 ? p ** (1 / t) : 0;
  });
  const sum = raised.reduce((a, b) => a + b, 0);
  if (sum <= 0) return Object.fromEntries(keys.map((k) => [k, 1 / keys.length]));
  return Object.fromEntries(keys.map((k, i) => [k, (raised[i] ?? 0) / sum]));
}

/** The calibrated probability of the option the answer named. Without probabilities, its own confidence. */
export function answerConfidence(a: Answer, temperature = 1): number {
  const value = String(a.value);
  const raw = a.probabilities;
  if (raw === undefined || raw[value] === undefined) return clamp01(a.confidence);
  return clamp01(applyTemperature(raw, temperature)[value] ?? 0);
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
