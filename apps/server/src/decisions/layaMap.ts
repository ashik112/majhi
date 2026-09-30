import {
  ABSTAIN,
  type Answer,
  askedOptions,
  choiceOptions,
  type DecideRequest,
  type DecideState,
  type LayaAnswer,
  type LayaQuestion,
  type Option,
  type OrderRuns,
  type Question,
} from "@majhi/shared";
import { fitState, questionTokens, renderState, stateBudget } from "./trim.ts";

/** Laya reads score levels as text; a wide range would fill its window. */
export const MAX_SCORE_LEVELS = 10;
/** Most cyclic shifts a `shifted` choice is asked in. */
export const MAX_SHIFTS = 6;

/**
 * A yes/no question as Laya gets it: two neutral options described, never yes or no words, asked
 * in both orders (Laya's own `noul` follows its labels more than the state).
 */
const YES = "A";
const NO = "B";
const NOUL_TRUE = "the statement in the question holds";
const NOUL_FALSE = "the statement in the question does not hold";

/** One question as sent: the Laya key, and the option keys in the order they were sent. */
interface Run {
  id: string;
  question: LayaQuestion;
  order: string[];
}

/** The orders a choice is asked in. The abstain option is not in `keys`: it always goes last. */
export function orderRuns(keys: readonly string[], how: OrderRuns): string[][] {
  const n = keys.length;
  if (how === "reversed" && n > 1) return [[...keys], [...keys].reverse()];
  if (how === "shifted" && n > 1) {
    const k = Math.min(n, MAX_SHIFTS);
    return Array.from({ length: k }, (_, i) => {
      const s = Math.floor((i * n) / k);
      return [...keys.slice(s), ...keys.slice(0, s)];
    });
  }
  return [[...keys]];
}

function choiceRuns(
  key: string,
  instructions: string,
  options: readonly Option[],
  how: OrderRuns,
  abstain: boolean,
): Run[] {
  const byKey = new Map(options.map((o) => [o.key, o]));
  const runs = orderRuns(
    options.map((o) => o.key),
    how,
  );
  return runs.map((keys, i) => {
    const order = abstain ? [...keys, ABSTAIN.key] : keys;
    const described = abstain || options.some((o) => o.description !== undefined);
    // Laya reads `key: description`, or the bare key when the description is empty.
    const criteria = described
      ? Object.fromEntries(
          order.map((k) => [
            k,
            k === ABSTAIN.key && abstain ? ABSTAIN.description : (byKey.get(k)?.description ?? ""),
          ]),
        )
      : order;
    return {
      id: runs.length === 1 ? key : `${key}#${i}`,
      question: { type: "choice", instructions, criteria },
      order,
    };
  });
}

/** Our question as the Laya questions it takes: one per order run. */
export function toLayaRuns(key: string, q: Question): Run[] {
  switch (q.type) {
    case "choice":
      return choiceRuns(key, q.instructions, choiceOptions(q), q.orders, q.abstain);
    case "noul":
      return choiceRuns(
        key,
        q.instructions,
        [
          { key: YES, description: q.criteria?.true ?? NOUL_TRUE },
          { key: NO, description: q.criteria?.false ?? NOUL_FALSE },
        ],
        "reversed",
        false,
      );
    case "score": {
      const levels = q.max - q.min + 1;
      if (levels < 2 || levels > MAX_SCORE_LEVELS) {
        throw new Error(`A score needs 2 to ${MAX_SCORE_LEVELS} levels, from min to max.`);
      }
      const criteria = Array.from({ length: levels }, (_, i) => String(q.min + i));
      criteria[0] = `${criteria[0]} (lowest)`;
      criteria[levels - 1] = `${criteria[levels - 1]} (highest)`;
      return [{ id: key, question: { type: "score", instructions: q.instructions, criteria }, order: [] }];
    }
  }
}

/** The probabilities of one run by option key. A run without them counts as sure of its choice. */
function runProbabilities(run: Run, a: LayaAnswer): Record<string, number> {
  if (a.choice === undefined || !run.order.includes(a.choice))
    throw new Error("Laya answered with an unknown option.");
  const out: Record<string, number> = {};
  for (const k of run.order) out[k] = clamp(a.probabilities?.[k] ?? (k === a.choice ? 1 : 0));
  return out;
}

/** The mean of each option's probability over the runs, in the order the options were given. */
function average(keys: readonly string[], runs: readonly Record<string, number>[]): Record<string, number> {
  return Object.fromEntries(
    keys.map((k) => [k, runs.reduce((sum, r) => sum + (r[k] ?? 0), 0) / Math.max(1, runs.length)]),
  );
}

/** The key with the highest probability; the first given wins a tie. */
function top(p: Record<string, number>): string {
  let best = "";
  let bestP = -1;
  for (const [k, v] of Object.entries(p)) {
    if (v > bestP) {
      best = k;
      bestP = v;
    }
  }
  return best;
}

/**
 * Laya's answers to one of our questions, in our shape. A choice asked in several orders gets the
 * mean probability of each option, and its answer is the most probable one. `confidence` is the
 * answer's probability, not Laya's entropy score, which is near zero for a clear 3-way pick.
 */
export function fromLayaRuns(q: Question, runs: readonly Run[], answers: readonly LayaAnswer[]): Answer {
  if (q.type === "score") {
    const a = answers[0];
    if (a?.score === undefined) throw new Error("Laya gave no score.");
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
  const per = runs.map((run, i) => {
    const a = answers[i];
    if (a === undefined) throw new Error("Laya gave no answer for a run.");
    return runProbabilities(run, a);
  });
  const keys = q.type === "choice" ? askedOptions(q).map((o) => o.key) : [YES, NO];
  const mean = average(keys, per);
  const several = per.length > 1;
  if (q.type === "choice") {
    const value = top(mean);
    return {
      value,
      probabilities: mean,
      confidence: clamp(mean[value] ?? 0),
      ...(several ? { runs: per } : {}),
    };
  }
  const yes = mean[YES] ?? 0;
  const no = mean[NO] ?? 0;
  const asBool = (r: Record<string, number>) => ({ true: r[YES] ?? 0, false: r[NO] ?? 0 });
  return {
    value: yes >= no,
    probabilities: asBool(mean),
    confidence: clamp(Math.max(yes, no)),
    ...(several ? { runs: per.map(asBool) } : {}),
  };
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
  /** Every question as sent, one per order run: `key` or `key#0`, `key#1`, ... */
  questions: Record<string, LayaQuestion>;
  /** True when the state was cut, or Laya cuts a question or its options. */
  trimmed: boolean;
  runs: Record<string, Run[]>;
}

/** Maps the questions into order runs and fits the state into what the longest question leaves. */
export function toLayaCall(request: DecideRequest): LayaCall {
  const runs = Object.fromEntries(
    Object.entries(request.questions).map(([key, q]) => [key, toLayaRuns(key, q)]),
  );
  const questions = Object.fromEntries(
    Object.values(runs)
      .flat()
      .map((r) => [r.id, r.question]),
  );
  const list = Object.values(questions);
  const fitted = fitState(request.state, stateBudget(list));
  const cut = list.some((q) => questionTokens(q).cut);
  return {
    text: renderState(fitted.state),
    state: fitted.state,
    questions,
    trimmed: fitted.trimmed || cut,
    runs,
  };
}

/** Laya's answers in our shape, the runs of each question averaged. Throws when one is missing. */
export function fromLayaCall(
  call: LayaCall,
  request: DecideRequest,
  raw: Record<string, LayaAnswer>,
): Record<string, Answer> {
  return Object.fromEntries(
    Object.entries(request.questions).map(([key, q]) => {
      const runs = call.runs[key] ?? [];
      const answers = runs.map((r) => {
        const a = raw[r.id];
        if (a === undefined) throw new Error(`Laya gave no answer for "${r.id}".`);
        return a;
      });
      return [key, fromLayaRuns(q, runs, answers)];
    }),
  );
}
