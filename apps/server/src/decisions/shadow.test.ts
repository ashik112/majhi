import type { Answer, DecideRequest } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { LayaScript } from "./testkit.ts";
import { fakeLaya, service, sure } from "./testkit.ts";

const SIZE_SLOT = { id: "size", title: "Size", use: "task-size" as const, question: /^size$/, target: 0.9 };
const ask = (state: string) => ({
  state,
  questions: {
    size: {
      type: "choice" as const,
      instructions: "How big?",
      options: ["small", "large"],
      orders: "reversed" as const,
    },
  },
});

/** Plays a Laya that reads the words: "tiny" is small, "huge" is large, both at 0.97 in both orders. */
const reads: LayaScript = async (request: DecideRequest) =>
  Object.fromEntries(
    Object.entries(request.questions).map(([key, q]) => [
      key,
      sure(q, JSON.stringify(request.state).includes("huge") ? "large" : "small", 0.97),
    ]),
  );

describe("shadow mode", () => {
  it("logs a confident answer from a slot with no labels and acts on nothing", async () => {
    const { svc } = service(fakeLaya({ script: reads }), undefined, [SIZE_SLOT]);
    const r = await svc.decide(ask("huge migration"), { use: "task-size" });
    const gate = r.answers.size?.gate;
    expect(r.answers.size?.value).toBe("large");
    expect(gate).toMatchObject({ accepted: false, shadow: true });
    // The answer is in the log with its probabilities, so it can be compared with what happened.
    const logged = svc.recent(1)[0];
    expect(logged?.answers.size?.gate?.shadow).toBe(true);
    expect(logged?.answers.size?.probabilities?.large).toBeCloseTo(0.97);
    expect(svc.slots()[0]).toMatchObject({ slot: "size", mode: "shadow", labels: 0 });
  });

  it("goes live after an eval on enough labels, acts, and falls back to shadow when the model changes", async () => {
    const laya = fakeLaya({ script: reads });
    const { svc } = service(laya, undefined, [SIZE_SLOT]);
    // 60 decisions, labeled by what happened: the words decide, and Laya reads the words.
    for (let i = 0; i < 60; i += 1) {
      const big = i % 2 === 0;
      const r = await svc.decide(ask(`${big ? "huge" : "tiny"} task number ${i}`), { use: "task-size" });
      svc
        .labels()
        .add({ decisionId: r.id, question: "size", label: big ? "large" : "small", source: "outcome" });
    }
    const [report] = await svc.runEvals("size");
    expect(report?.metrics).toMatchObject({ accuracy: 1, orderConsistency: 1 });
    expect(report?.calibration).toMatchObject({ mode: "live", version: "0.2.0" });
    expect(svc.slots()[0]).toMatchObject({ mode: "live", labels: 60 });

    const live = await svc.decide(ask("huge rewrite of billing"), { use: "task-size" });
    expect(live.answers.size?.gate).toMatchObject({ accepted: true });
    expect(live.answers.size?.gate?.shadow).toBeUndefined();

    // A new checkpoint is a different model: the old eval does not vouch for it.
    laya.version = "0.3.0";
    const stale = await svc.decide(ask("huge rewrite of billing"), { use: "task-size" });
    expect(stale.answers.size?.gate).toMatchObject({ accepted: false, shadow: true });
  });

  it("stays in shadow when the labels say the model is wrong, however sure it sounded", async () => {
    const laya = fakeLaya({ script: reads });
    const { svc } = service(laya, undefined, [SIZE_SLOT]);
    // The owner's labels contradict Laya on almost every one.
    for (let i = 0; i < 60; i += 1) {
      const big = i % 2 === 0;
      const r = await svc.decide(ask(`${big ? "huge" : "tiny"} task number ${i}`), { use: "task-size" });
      svc.labels().add({
        decisionId: r.id,
        question: "size",
        label: i % 10 === 0 ? (big ? "large" : "small") : big ? "small" : "large",
        source: "owner",
      });
    }
    const [report] = await svc.runEvals("size");
    expect(report?.calibration?.mode).toBe("shadow");
    expect(report?.metrics.accuracy).toBeLessThan(0.3);
    const r = await svc.decide(ask("huge rewrite of billing"), { use: "task-size" });
    expect(r.answers.size?.gate?.accepted).toBe(false);
  });
});

describe("the chain when Laya misbehaves", () => {
  it("falls back to the rules at once when Laya hangs, instead of waiting out a slow call", async () => {
    const laya = fakeLaya({ script: () => new Promise(() => {}) });
    const { svc } = service(laya, undefined, [SIZE_SLOT], { laya: 30 });
    const r = await svc.decide(ask("anything"), { use: "task-size" });
    expect(r.provider).toBe("rules");
    expect(r.answers.size?.gate?.accepted).toBe(false);
    expect(r.skipped.some((s) => s.provider === "laya")).toBe(true);
    expect(svc.cache.stats().size).toBe(0);
  });

  it("survives garbage: an unknown option, NaN probabilities, an empty answer set", async () => {
    const garbage: Answer = {
      value: "huge",
      confidence: Number.NaN,
      probabilities: { huge: Number.NaN, small: -1 },
      runs: [{}, {}],
    };
    const laya = fakeLaya({ script: async () => ({ size: garbage }) });
    const { svc } = service(laya, undefined, [SIZE_SLOT]);
    const r = await svc.decide(ask("x"), { use: "task-size" });
    expect(r.answers.size?.gate?.accepted).toBe(false);
    const empty = fakeLaya({ script: async () => ({}) });
    const again = service(empty, undefined, [SIZE_SLOT]);
    const none = await again.svc.decide(ask("x"), { use: "task-size" });
    expect(none.answers).toEqual({});
    expect(
      await again.svc.rateTask({ title: "t", brief: "b", kind: "code", repos: [], role: "Builder" }),
    ).toBeUndefined();
  });
});

describe("the answer cache under attack", () => {
  it("does not serve an answer from an older checkpoint", async () => {
    const laya = fakeLaya({
      script: async (request) =>
        Object.fromEntries(
          Object.entries(request.questions).map(([k, q]) => [
            k,
            sure(q, laya.version === "0.2.0" ? "small" : "large", 0.97),
          ]),
        ),
    });
    const { svc } = service(laya, undefined, [SIZE_SLOT]);
    const first = await svc.decide(ask("same words"), { use: "task-size" });
    expect(first.answers.size?.value).toBe("small");
    laya.version = "0.3.0";
    const second = await svc.decide(ask("same words"), { use: "task-size" });
    expect(second.cached).toBeUndefined();
    expect(second.answers.size?.value).toBe("large");
    expect(laya.calls).toBe(2);
  });

  it("does not serve a gate decided before a refit", async () => {
    const laya = fakeLaya({ script: reads });
    const { svc } = service(laya, undefined, [SIZE_SLOT]);
    for (let i = 0; i < 60; i += 1) {
      const big = i % 2 === 0;
      const r = await svc.decide(ask(`${big ? "huge" : "tiny"} number ${i}`), { use: "task-size" });
      svc
        .labels()
        .add({ decisionId: r.id, question: "size", label: big ? "large" : "small", source: "outcome" });
    }
    const before = await svc.decide(ask("huge repeat"), { use: "task-size" });
    expect(before.answers.size?.gate?.shadow).toBe(true);
    await svc.runEvals("size");
    const after = await svc.decide(ask("huge repeat"), { use: "task-size" });
    // The cache key changed with the calibration, so this was asked again and gated with the new fit.
    expect(after.cached).toBeUndefined();
    expect(after.answers.size?.gate?.accepted).toBe(true);
  });
});
