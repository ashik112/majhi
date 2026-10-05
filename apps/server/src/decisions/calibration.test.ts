import {
  type Answer,
  type Calibration,
  DecisionSettingsSchema,
  type Question,
  QuestionSchema,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { ordersAgree } from "./answers.ts";
import {
  baseGate,
  chooseThreshold,
  fitSlot,
  fitTemperature,
  liveGate,
  thresholdGate,
} from "./calibration.ts";
import type { RawItem } from "./evalRunner.ts";
import { MIN_LABELS, type SlotDef } from "./slots.ts";

const settings = DecisionSettingsSchema.parse({});
const choice: Question = QuestionSchema.parse({
  type: "choice",
  instructions: "Pick",
  options: ["a", "b"],
});
const answer = (value: string, p: number, runs?: Record<string, number>[]): Answer => ({
  value,
  confidence: p,
  probabilities: { [value]: p, [value === "a" ? "b" : "a"]: (1 - p) * 0.9, none: (1 - p) * 0.1 },
  ...(runs === undefined ? {} : { runs }),
});
const slot: SlotDef = { id: "test-slot", title: "Test", use: "routing", question: /^q$/, target: 0.9 };
const cal = (over: Partial<Calibration> = {}): Calibration => ({
  slot: "test-slot",
  mode: "live",
  temperature: 1,
  threshold: 0.8,
  target: 0.9,
  heldOutPrecision: 0.95,
  heldOutCoverage: 0.5,
  labels: 80,
  version: "m1",
  fittedAt: "2026-10-04T00:00:00.000Z",
  reason: "Live",
  ...over,
});

describe("temperature", () => {
  it("fits T above 1 for an over-confident model and below 1 for an under-confident one", () => {
    // Says 0.95 and is right half the time.
    const over = Array.from({ length: 40 }, (_, i) => ({
      probabilities: { a: 0.95, b: 0.05 },
      truth: i % 2 === 0 ? "a" : "b",
    }));
    expect(fitTemperature(over)).toBeGreaterThan(1.5);
    // Says 0.6 and is always right.
    const under = Array.from({ length: 40 }, () => ({ probabilities: { a: 0.6, b: 0.4 }, truth: "a" }));
    expect(fitTemperature(under)).toBeLessThan(0.8);
    expect(fitTemperature([])).toBe(1);
  });
});

describe("the threshold", () => {
  it("picks the lowest bar that reaches the target with enough answers", () => {
    const c = [
      ...Array.from({ length: 12 }, (_, i) => ({
        confidence: 0.95 - i * 0.005,
        correct: true,
        agrees: true,
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        confidence: 0.6 - i * 0.01,
        correct: i % 2 === 0,
        agrees: true,
      })),
    ];
    const t = chooseThreshold(c, 0.95);
    // The first 12 are right, then the 0.60 one is right too (13 of 13); the next, at 0.59, is not (13 of 14).
    expect(t).toBeCloseTo(0.6);
    // A looser target accepts more.
    expect(chooseThreshold(c, 0.7)).toBeLessThan(0.6);
  });

  it("returns nothing when no bar reaches the target, or too few answers clear it", () => {
    const coin = Array.from({ length: 40 }, (_, i) => ({
      confidence: 0.9,
      correct: i % 2 === 0,
      agrees: true,
    }));
    expect(chooseThreshold(coin, 0.9)).toBeUndefined();
    const few = Array.from({ length: 4 }, () => ({ confidence: 0.99, correct: true, agrees: true }));
    expect(chooseThreshold(few, 0.9)).toBeUndefined();
  });

  it("cannot split a tie, and never lets through an answer whose orders disagree", () => {
    const tie = [
      ...Array.from({ length: 10 }, () => ({ confidence: 0.9, correct: true, agrees: true })),
      ...Array.from({ length: 10 }, () => ({ confidence: 0.9, correct: false, agrees: true })),
    ];
    expect(chooseThreshold(tie, 0.9)).toBeUndefined();
    const flips = Array.from({ length: 30 }, () => ({ confidence: 0.99, correct: true, agrees: false }));
    expect(chooseThreshold(flips, 0.5)).toBeUndefined();
  });
});

describe("the gates", () => {
  it("a fitted map changes what is accepted: the same answer passes at T=1 and fails once flattened", () => {
    const a = answer("a", 0.85);
    expect(thresholdGate(choice, a, { temperature: 1, threshold: 0.8 }, settings).accepted).toBe(true);
    const flat = thresholdGate(choice, a, { temperature: 4, threshold: 0.8 }, settings);
    expect(flat.accepted).toBe(false);
    expect(flat.confidence).toBeLessThan(0.8);
  });

  it("never counts the abstain option, whatever its confidence", () => {
    const none: Answer = {
      value: "none",
      confidence: 0.99,
      probabilities: { none: 0.99, a: 0.005, b: 0.005 },
    };
    expect(thresholdGate(choice, none, { temperature: 1, threshold: 0.1 }, settings).accepted).toBe(false);
    expect(baseGate(choice, none, settings).accepted).toBe(false);
  });

  it("rejects an answer whose option orders disagree, even when it is very sure", () => {
    const runs = [
      { a: 0.99, b: 0.005, none: 0.005 },
      { a: 0.1, b: 0.89, none: 0.01 },
    ];
    const a = { ...answer("a", 0.99), runs };
    expect(ordersAgree(a)).toBe(false);
    expect(thresholdGate(choice, a, { temperature: 1, threshold: 0.5 }, settings).accepted).toBe(false);
    expect(baseGate(choice, a, settings).accepted).toBe(false);
    // A single run cannot be checked and is not held against the answer.
    expect(ordersAgree(answer("a", 0.99))).toBeUndefined();
  });

  it("live gate: no labels is a shadow; a use read by hand keeps the base bar; start-live keeps it too", () => {
    const a = answer("a", 0.97);
    const input = { q: choice, a, cal: undefined, settings, version: "m1", labels: 3 };
    const shadow = liveGate({ ...input, slot });
    expect(shadow).toMatchObject({ accepted: false, shadow: true });
    expect(liveGate({ ...input, slot: { ...slot, use: "tool" } }).accepted).toBe(true);
    expect(liveGate({ ...input, slot: { ...slot, use: "owner" } }).accepted).toBe(true);
    expect(liveGate({ ...input, slot: { ...slot, startMode: "live" } }).accepted).toBe(true);
  });

  it("live gate: a live calibration acts, a shadow one does not, and a new checkpoint needs a new eval", () => {
    const a = answer("a", 0.97);
    const input = { slot, q: choice, a, settings, labels: 80 };
    expect(liveGate({ ...input, cal: cal(), version: "m1" }).accepted).toBe(true);
    expect(
      liveGate({ ...input, cal: cal({ mode: "shadow", reason: "Shadow: held 60%" }), version: "m1" }),
    ).toMatchObject({
      accepted: false,
      shadow: true,
    });
    const stale = liveGate({ ...input, cal: cal(), version: "m2" });
    expect(stale).toMatchObject({ accepted: false, shadow: true });
    // An unknown checkpoint (empty) is not held against it.
    expect(liveGate({ ...input, cal: cal(), version: "" }).accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

/** A small deterministic generator, so a test is the same every run. */
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** `n` labeled items from a model whose confidence tracks being right with `skill` (0 = noise, 1 = perfect). */
function items(n: number, skill: number, seed = 7, classes = ["a", "b"]): RawItem[] {
  const rnd = lcg(seed);
  return Array.from({ length: n }, (_, i) => {
    const truth = classes[Math.floor(rnd() * classes.length)] ?? "a";
    const right = rnd() < 0.5 + 0.5 * skill;
    const value = right ? truth : (classes.find((c) => c !== truth) ?? "b");
    // Confident when sure; a skilled model is more confident on the ones it gets right.
    const p = right ? 0.7 + 0.29 * (skill * rnd() + (1 - skill) * rnd()) : 0.55 + 0.4 * (1 - skill) * rnd();
    return {
      id: `d${i}`,
      question: choice,
      truth,
      answer: answer(value, Math.min(0.99, p), [
        { [value]: 0.9, [value === "a" ? "b" : "a"]: 0.1 },
        { [value]: 0.88, [value === "a" ? "b" : "a"]: 0.12 },
      ]),
      latencyMs: 12,
      consistent: true,
    };
  });
}

const opts = { now: () => new Date("2026-10-04T12:00:00.000Z"), settings };

describe("fitSlot", () => {
  it("goes live for a model that is right when it is sure", () => {
    const fit = fitSlot({ ...slot, target: 0.85 }, items(200, 1), "m1", opts);
    expect(fit?.calibration.mode).toBe("live");
    expect(fit?.calibration.threshold).toBeLessThan(1);
    expect(fit?.heldOut.precision).toBeGreaterThanOrEqual(0.85);
  });

  it("stays in shadow for a model at chance, however sure it sounds", () => {
    const fit = fitSlot(slot, items(200, 0), "m1", opts);
    expect(fit?.calibration.mode).toBe("shadow");
  });

  it("fits nothing below the label floor", () => {
    expect(fitSlot(slot, items(MIN_LABELS - 1, 1), "m1", opts)).toBeUndefined();
    expect(fitSlot(slot, [], "m1", opts)).toBeUndefined();
    // Failed items do not count toward the floor.
    const failed = items(MIN_LABELS + 20, 1).map((i, n) => (n < 25 ? { ...i, answer: undefined } : i));
    expect(fitSlot(slot, failed, "m1", opts)).toBeUndefined();
  });

  it("stays in shadow for a one-class collapse: always the same answer", () => {
    const collapsed = items(150, 1).map((i) => ({
      ...i,
      answer: answer("a", 0.95, [
        { a: 0.95, b: 0.05 },
        { a: 0.95, b: 0.05 },
      ]),
    }));
    // About half the truths are "b", so precision cannot reach 0.9 at any bar.
    expect(fitSlot(slot, collapsed, "m1", opts)?.calibration.mode).toBe("shadow");
  });

  it("never lets an order-flipping model go live, even when its averaged probabilities look sure", () => {
    const flipping = items(150, 1).map((i) => ({
      ...i,
      answer: {
        ...(i.answer as Answer),
        runs: [
          { a: 0.95, b: 0.05 },
          { a: 0.05, b: 0.95 },
        ],
      },
    }));
    expect(fitSlot(slot, flipping, "m1", opts)?.calibration.mode).toBe("shadow");
  });

  it("treats the slot's classes, not the raw options, as the answer", () => {
    const grouped: SlotDef = { ...slot, classOf: (v) => (v === "keep" ? "keep" : "not-keep") };
    const raw = items(150, 1, 3, ["keep", "not-keep"]).map((i) => {
      const value = i.truth === "keep" ? "keep" : "one-off";
      const q = QuestionSchema.parse({
        type: "choice",
        instructions: "x",
        options: ["keep", "one-off", "generic"],
      });
      return {
        ...i,
        question: q,
        answer: {
          value,
          confidence: 0.9,
          probabilities: {
            [value]: 0.9,
            keep: value === "keep" ? 0.9 : 0.05,
            "one-off": 0.04,
            generic: 0.04,
            none: 0.01,
          },
          runs: [{ [value]: 0.9 }, { [value]: 0.9 }],
        } as Answer,
      };
    });
    expect(fitSlot(grouped, raw, "m1", opts)?.calibration.mode).toBe("live");
  });
});
