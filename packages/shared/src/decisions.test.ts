import { describe, expect, it } from "vitest";
import { gateAnswer, type Question, QuestionSchema } from "./decisions.ts";

const BAR = { min_lift: 0.2, min_margin: 0.05 };
const q = (input: unknown): Question => QuestionSchema.parse(input);
const sizes = q({ type: "choice", instructions: "How big?", options: ["small", "medium", "large"] });

describe("gateAnswer", () => {
  it("adjusts for chance: the same probability is a clear pick among 4 options and a coin flip among 2", () => {
    // 4 options with `none`: 0.4 is (4 * 0.4 - 1) / 3 = 0.2 over chance.
    const four = gateAnswer(
      sizes,
      { value: "small", confidence: 0.4, probabilities: { small: 0.4, medium: 0.3, large: 0.2, none: 0.1 } },
      BAR,
    );
    expect(four.lift).toBeCloseTo(0.2);
    expect(four).toMatchObject({ accepted: true, reason: "0.20 over chance, 0.10 ahead" });

    const yesNo = q({ type: "noul", instructions: "Approved?" });
    const two = gateAnswer(
      yesNo,
      { value: true, confidence: 0.55, probabilities: { true: 0.55, false: 0.45 } },
      BAR,
    );
    expect(two.lift).toBeCloseTo(0.1);
    expect(two).toMatchObject({ accepted: false, reason: "0.10 over chance, under 0.20" });
  });

  it("needs the lead over the runner-up, and names the runner-up", () => {
    const close = gateAnswer(
      sizes,
      {
        value: "large",
        confidence: 0.51,
        probabilities: { small: 0.02, medium: 0.48, large: 0.51, none: 0.0 },
      },
      BAR,
    );
    expect(close.accepted).toBe(false);
    expect(close.reason).toBe("0.03 ahead of medium, under 0.05");
    expect(close.margin).toBeCloseTo(0.03);
  });

  it("never counts the abstain option, however sure", () => {
    const none = gateAnswer(
      sizes,
      {
        value: "none",
        confidence: 0.9,
        probabilities: { small: 0.05, medium: 0.03, large: 0.02, none: 0.9 },
      },
      BAR,
    );
    expect(none).toMatchObject({ accepted: false, reason: "it said none of the options fits" });
    // Without the abstain option, `none` is an ordinary key.
    const plain = q({ type: "choice", instructions: "x", options: ["none", "some"], abstain: false });
    expect(
      gateAnswer(plain, { value: "none", confidence: 0.9, probabilities: { none: 0.9, some: 0.1 } }, BAR)
        .accepted,
    ).toBe(true);
  });

  it("takes the rest as spread evenly when there are no probabilities", () => {
    // 4 options, 0.5: lift (2 - 1) / 3 = 0.33, the others 0.5 / 3 = 0.17 each.
    const g = gateAnswer(sizes, { value: "small", confidence: 0.5 }, BAR);
    expect(g.lift).toBeCloseTo(1 / 3);
    expect(g.margin).toBeCloseTo(0.5 - 0.5 / 3);
    expect(g.accepted).toBe(true);
    expect(gateAnswer(sizes, { value: "small", confidence: 0.3 }, BAR).accepted).toBe(false);
  });

  it("reads a score's levels as its options", () => {
    const score = q({ type: "score", instructions: "How hard?", min: 1, max: 3 });
    const g = gateAnswer(
      score,
      { value: 2, confidence: 0.6, probabilities: { "1": 0.1, "2": 0.6, "3": 0.3 } },
      BAR,
    );
    expect(g.lift).toBeCloseTo(0.4);
    expect(g.margin).toBeCloseTo(0.3);
  });

  it("does not round a number up to the bar", () => {
    const g = gateAnswer(sizes, { value: "small", confidence: 0.3997 }, { min_lift: 0.2, min_margin: 0 });
    expect(g.reason).toBe("0.19 over chance, under 0.20");
  });
});
