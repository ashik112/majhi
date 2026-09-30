import {
  type Answer,
  choiceOptions,
  type DecideRequest,
  type DecideState,
  type LayaAnswer,
  type LayaQuestion,
  optionKey,
  type Question,
} from "@majhi/shared";
import { fitState, questionTokens, renderState, stateBudget } from "./trim.ts";

/** Laya reads score levels as text; a wide range would fill its window. */
export const MAX_SCORE_LEVELS = 10;

/**
 * Our question types onto Laya's: `choice` is `choice` (options as labels), `score` is `score`
 * with one level per integer from min to max, `noul` is `noul` (Laya has no true/false labels
 * beyond the defaults).
 */
export function toLayaQuestion(q: Question): LayaQuestion {
  switch (q.type) {
    case "choice": {
      const options = choiceOptions(q);
      // Laya reads `key: description`, or the bare key when the description is empty.
      const criteria = options.some((o) => o.description !== undefined)
        ? Object.fromEntries(options.map((o) => [o.key, o.description ?? ""]))
        : options.map((o) => o.key);
      return { type: "choice", instructions: q.instructions, criteria };
    }
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
      if (value === undefined || !q.options.map(optionKey).includes(value))
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

/** What goes to Laya for one request, and what the log keeps of it. */
export interface LayaCall {
  /** The state as Laya reads it: text, or fields rendered as JSON. */
  text: string;
  /** The state after fitting, before rendering. */
  state: DecideState;
  questions: Record<string, LayaQuestion>;
  /** True when the state was cut, or Laya cuts a question or its options. */
  trimmed: boolean;
}

/** Maps the questions and fits the state into what the longest question leaves of the window. */
export function toLayaCall(request: DecideRequest): LayaCall {
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([key, q]) => [key, toLayaQuestion(q)]),
  );
  const list = Object.values(questions);
  const fitted = fitState(request.state, stateBudget(list));
  const cut = list.some((q) => questionTokens(q).cut);
  return { text: renderState(fitted.state), state: fitted.state, questions, trimmed: fitted.trimmed || cut };
}

/** Laya's answers in our shape. Throws when one is missing. */
export function fromLayaCall(
  request: DecideRequest,
  raw: Record<string, LayaAnswer>,
): Record<string, Answer> {
  return Object.fromEntries(
    Object.entries(request.questions).map(([key, q]) => {
      const a = raw[key];
      if (a === undefined) throw new Error(`Laya gave no answer for "${key}".`);
      return [key, fromLayaAnswer(q, a)];
    }),
  );
}
