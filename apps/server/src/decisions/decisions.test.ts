import {
  type DecideRequest,
  type DecideRequestInput,
  DecideRequestSchema,
  type LayaAnswer,
  type Question,
  QuestionSchema,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { parseReply } from "./acpParse.ts";
import { runChain } from "./chain.ts";
import { fromLayaCall, orderRuns, toLayaCall } from "./layaMap.ts";
import type { DecisionProvider } from "./providers.ts";

const parse = (r: DecideRequestInput): DecideRequest => DecideRequestSchema.parse(r);
const choice: Question = QuestionSchema.parse({
  type: "choice",
  instructions: "Pick a model",
  options: ["haiku", "sonnet", "opus"],
  abstain: false,
});
const request: DecideRequest = parse({
  state: "Fix a typo in the readme",
  questions: {
    model: choice,
    hard: { type: "score", instructions: "How hard?", min: 1, max: 5 },
    risky: { type: "noul", instructions: "Touches payments?" },
  },
});

/** Plays Laya: answers each question sent with the probabilities `pick` gives for its options. */
function laya(r: DecideRequest, pick: (id: string, keys: string[]) => Record<string, number>) {
  const call = toLayaCall(r);
  const raw: Record<string, LayaAnswer> = {};
  for (const [id, q] of Object.entries(call.questions)) {
    const keys = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria ?? {});
    if (q.type === "score") {
      raw[id] = {
        type: "score",
        score: 1.2,
        confidence: 0.1,
        probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 },
      };
      continue;
    }
    const p = pick(id, keys);
    const choice = Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0];
    raw[id] = {
      type: "choice",
      confidence: 0.1,
      probabilities: p,
      ...(choice === undefined ? {} : { choice }),
    };
  }
  return { call, answers: fromLayaCall(call, r, raw) };
}

function provider(id: DecisionProvider["id"], behaviour: "ok" | "down" | "throws"): DecisionProvider {
  return {
    id,
    unavailable: async () => (behaviour === "down" ? `${id} is down` : undefined),
    decide: async () => {
      if (behaviour === "throws") throw new Error(`${id} broke`);
      return {
        answers: { model: { value: "haiku", confidence: 0.9 } },
        estimated: id === "acp",
        trimmed: false,
      };
    },
  };
}

describe("chain", () => {
  const set = (b: Record<string, "ok" | "down" | "throws">) => ({
    laya: provider("laya", b.laya ?? "ok"),
    jev: provider("jev", b.jev ?? "ok"),
    acp: provider("acp", b.acp ?? "ok"),
    rules: provider("rules", b.rules ?? "ok"),
  });

  it("uses the first provider that answers and records why earlier ones were skipped", async () => {
    const result = await runChain(["laya", "acp", "rules"], set({ laya: "down", acp: "throws" }), request);
    expect(result.provider).toBe("rules");
    expect(result.skipped.map((x) => x.provider)).toEqual(["laya", "acp"]);
  });

  it("fails when nothing answers", async () => {
    await expect(runChain(["laya", "jev"], set({ laya: "down", jev: "down" }), request)).rejects.toThrow();
  });
});

describe("Laya mapping", () => {
  it("asks in both orders or in cyclic shifts, the abstain option always last", () => {
    expect(orderRuns(["a", "b", "c"], "once")).toEqual([["a", "b", "c"]]);
    expect(orderRuns(["a", "b", "c"], "reversed")).toEqual([
      ["a", "b", "c"],
      ["c", "b", "a"],
    ]);
    expect(orderRuns(["a", "b", "c"], "shifted")).toEqual([
      ["a", "b", "c"],
      ["b", "c", "a"],
      ["c", "a", "b"],
    ]);
    const ten = "abcdefghij".split("");
    expect(orderRuns(ten, "shifted").map((o) => o[0])).toEqual(["a", "b", "d", "f", "g", "i"]);
    const r = parse({
      state: "x",
      questions: { q: { type: "choice", instructions: "Which?", options: ["a", "b"], orders: "reversed" } },
    });
    expect(
      Object.entries(toLayaCall(r).questions).map(([id, q]) => [id, Object.keys(q.criteria ?? {})]),
    ).toEqual([
      ["q#0", ["a", "b", "none"]],
      ["q#1", ["b", "a", "none"]],
    ]);
  });

  it("averages each option's probability over the runs, and answers with the most probable key", () => {
    const r = parse({
      state: "x",
      questions: {
        q: { type: "choice", instructions: "Which?", options: ["a", "b", "c"], orders: "reversed" },
      },
    });
    // Laya favours the first place: `a` wins the first order, `c` the second, `b` is steady.
    const { answers } = laya(r, (id) =>
      id === "q#0" ? { a: 0.5, b: 0.35, c: 0.1, none: 0.05 } : { c: 0.5, b: 0.35, a: 0.1, none: 0.05 },
    );
    expect(answers.q).toEqual({
      value: "b",
      confidence: 0.35,
      probabilities: { a: 0.3, b: 0.35, c: 0.3, none: 0.05 },
      runs: [
        { a: 0.5, b: 0.35, c: 0.1, none: 0.05 },
        { c: 0.5, b: 0.35, a: 0.1, none: 0.05 },
      ],
    });
  });

  it("maps a score level back to the asked range, and refuses an unknown option", () => {
    const { answers } = laya(request, (id) =>
      id === "model" ? { haiku: 0.2, sonnet: 0.7, opus: 0.1 } : { A: 0.5, B: 0.5 },
    );
    expect(answers.model).toMatchObject({ value: "sonnet", confidence: 0.7 });
    expect(answers.hard).toMatchObject({ value: 2, confidence: 0.5 });
    expect(() => laya(request, () => ({ gpt: 1 }))).toThrow();
  });
});

describe("stand-in agent replies", () => {
  it("accepts JSON in a code fence and checks it against the questions", () => {
    const good =
      '```json\n{"model":{"value":"opus","confidence":0.8},"hard":{"value":4,"confidence":0.6},"risky":{"value":true,"confidence":0.7}}\n```';
    const parsed = parseReply(good, request);
    expect(parsed.ok && parsed.answers.model).toEqual({ value: "opus", confidence: 0.8 });
  });

  it("rejects an option that was not offered, a fractional score and prose", () => {
    const bad = (model: unknown, hard: unknown) =>
      parseReply(
        JSON.stringify({
          model: { value: model, confidence: 1 },
          hard: { value: hard, confidence: 1 },
          risky: { value: false, confidence: 1 },
        }),
        request,
      );
    expect(bad("gpt", 3).ok).toBe(false);
    expect(bad("opus", 2.5).ok).toBe(false);
    expect(bad("opus", 9).ok).toBe(false);
    expect(parseReply("I think opus.", request).ok).toBe(false);
  });
});
