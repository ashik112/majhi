import {
  type DecideRequest,
  type DecideRequestInput,
  DecideRequestSchema,
  type Question,
  QuestionSchema,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { parseReply } from "./acpParse.ts";

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

describe("stand-in agent replies", () => {
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
