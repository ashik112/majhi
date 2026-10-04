import { describe, expect, it } from "vitest";
import { service } from "./testkit.ts";

const ask = {
  state: { task: "Fix a typo", kind: "code" as const },
  questions: {
    difficulty: { type: "choice" as const, instructions: "How big?", options: ["trivial", "large"] },
  },
};

describe("the owner's Wrong?", () => {
  it("stores the right answer for a decision with one question", async () => {
    const { svc } = service();
    const r = await svc.decide(ask, { use: "task-size" });
    const label = svc.label({ id: r.id, right: "large", note: "it touched six services" });
    expect(label).toMatchObject({
      source: "owner",
      question: "difficulty",
      label: "large",
      use: "task-size",
    });
    expect(svc.labels().forDecision(r.id)).toHaveLength(1);
  });

  it("refuses an answer the question did not offer, an unknown question and an unknown decision", async () => {
    const { svc } = service();
    const r = await svc.decide(ask, { use: "task-size" });
    expect(() => svc.label({ id: r.id, right: "gigantic" })).toThrow(/not one of/);
    expect(() => svc.label({ id: r.id, question: "other", right: "large" })).toThrow(/no question/);
    expect(() => svc.label({ id: "dec_missing", right: "large" })).toThrow(/no decision/);
  });

  it("asks which question when a decision has several", async () => {
    const { svc } = service();
    const r = await svc.decide(
      {
        state: "x",
        questions: {
          a: { type: "noul", instructions: "Is it a?" },
          b: { type: "noul", instructions: "Is it b?" },
        },
      },
      { use: "routing" },
    );
    expect(() => svc.label({ id: r.id, right: "true" })).toThrow(/Say which question/);
    expect(svc.label({ id: r.id, question: "b", right: "false" }).label).toBe("false");
  });
});
