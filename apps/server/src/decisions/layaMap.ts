import type { Answer, LayaAnswer, LayaQuestion, Question } from "@majhi/shared";

/** Laya reads score levels as text; a wide range would fill its window. */
export const MAX_SCORE_LEVELS = 10;

/**
 * Our question types onto Laya's: `choice` is `choice` (options as labels), `score` is `score`
 * with one level per integer from min to max, `noul` is `noul` (Laya has no true/false labels
 * beyond the defaults).
 */
export function toLayaQuestion(q: Question): LayaQuestion {
  switch (q.type) {
    case "choice":
      return { type: "choice", instructions: q.instructions, criteria: [...new Set(q.options)] };
    case "score": {
      const levels = q.max - q.min + 1;
      if (levels < 2 || levels > MAX_SCORE_LEVELS) {
        throw new Error(`A score needs 2 to ${MAX_SCORE_LEVELS} levels, from min to max.`);
      }
      const criteria = Array.from({ length: levels }, (_, i) => String(q.min + i));
      criteria[0] = `${criteria[0]} (lowest)`;
      criteria[levels - 1] = `${criteria[levels - 1]} (highest)`;
      return { type: "score", instructions: q.instructions, criteria };
    }
    case "noul":
      return { type: "noul", instructions: q.instructions };
  }
}

/**
 * Laya's answer in our shape. `confidence` is the probability of the answer given (for a choice
 * or score, the chosen option's; for noul, the larger side), not Laya's entropy score, which is
 * near zero for a clear 3-way pick and would fail any floor like 0.6.
 */
export function fromLayaAnswer(q: Question, a: LayaAnswer): Answer {
  switch (q.type) {
    case "choice": {
      const value = a.choice;
      if (value === undefined || !q.options.includes(value))
        throw new Error("Laya answered with an unknown option.");
      const p = a.probabilities?.[value];
      return {
        value,
        ...(a.probabilities === undefined ? {} : { probabilities: a.probabilities }),
        confidence: clamp(p ?? a.confidence),
      };
    }
    case "score": {
      if (a.score === undefined) throw new Error("Laya gave no score.");
      const index = Math.min(q.max - q.min, Math.max(0, Math.round(a.score)));
      const probabilities = Object.fromEntries(
        Object.entries(a.probabilities ?? {}).map(([i, p]) => [String(q.min + Number(i)), p]),
      );
      return {
        value: q.min + index,
        ...(a.probabilities === undefined ? {} : { probabilities }),
        confidence: clamp(a.probabilities?.[String(index)] ?? a.confidence),
      };
    }
    case "noul": {
      if (a.noul === undefined) throw new Error("Laya gave no true or false answer.");
      return {
        value: a.noul >= 0.5,
        probabilities: { true: a.noul, false: 1 - a.noul },
        confidence: clamp(Math.max(a.noul, 1 - a.noul)),
      };
    }
  }
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}
