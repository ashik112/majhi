import type { Answer, DecideRequest, Question } from "@majhi/shared";
import type { DecisionProvider } from "./providers.ts";

const FALLBACK_CONFIDENCE = 0.3;
const KEYWORD_CONFIDENCE = 0.5;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? []);
}

/** For `choice`: the one option named in the state, else the first option. */
function pickChoice(state: string, options: readonly string[]): Answer {
  const present = words(state);
  const named = options.filter((o) => present.has(o.toLowerCase()));
  if (named.length === 1 && named[0] !== undefined)
    return { value: named[0], confidence: KEYWORD_CONFIDENCE };
  return { value: options[0] ?? "", confidence: FALLBACK_CONFIDENCE };
}

export function ruleAnswer(state: string, question: Question): Answer {
  switch (question.type) {
    case "choice":
      return pickChoice(state, question.options);
    case "score":
      return { value: Math.round((question.min + question.max) / 2), confidence: FALLBACK_CONFIDENCE };
    case "noul":
      return { value: false, confidence: FALLBACK_CONFIDENCE };
  }
}

/** Deterministic answers with low confidence. Always available. */
export const rulesProvider: DecisionProvider = {
  id: "rules",
  unavailable: async () => undefined,
  decide: async (request: DecideRequest) => ({
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => [key, ruleAnswer(request.state, q)]),
    ),
    estimated: false,
    trimmed: false,
  }),
};
