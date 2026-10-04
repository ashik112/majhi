import { type DecideRequestInput, QuestionSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { cacheKey, DecisionCache } from "./cache.ts";
import { service } from "./testkit.ts";

const request: DecideRequestInput = {
  state: { task: "Fix a typo in the readme", kind: "task" },
  questions: {
    size: { type: "choice", instructions: "How big?", options: ["small", "large"], orders: "reversed" },
  },
};

describe("exact-match cache", () => {
  it("answers an identical request again without asking Laya, with the first decision's id", async () => {
    const { svc, laya } = service();
    const first = await svc.decide(request, { use: "task-size" });
    const again = await svc.decide(request, { use: "task-size", task: "tsk_other" });
    expect(laya.calls).toBe(1);
    expect(again).toMatchObject({ id: first.id, cached: true, provider: "laya" });
    expect(again.answers.size?.value).toBe("small");
    expect(again.answers.size?.gate).toBeDefined();
    expect(svc.recent(10)).toHaveLength(1);
    expect((await svc.status()).cache).toMatchObject({ hits: 1, misses: 1, size: 1, hitRate: 0.5 });
  });

  it("treats white space differences in the state as the same request", async () => {
    const { svc, laya } = service();
    await svc.decide({ ...request, state: "Fix  a typo\nin the readme" }, { use: "task-size" });
    await svc.decide({ ...request, state: "Fix a typo in the readme " }, { use: "task-size" });
    expect(laya.calls).toBe(1);
  });

  it("misses when the options, the state or the checkpoint change", async () => {
    const { svc, laya } = service();
    await svc.decide(request, { use: "task-size" });
    await svc.decide({ ...request, state: "Rewrite the parser" }, { use: "task-size" });
    await svc.decide(
      {
        ...request,
        questions: {
          size: { type: "choice", instructions: "How big?", options: ["large", "small"], orders: "reversed" },
        },
      },
      { use: "task-size" },
    );
    expect(laya.calls).toBe(3);
    laya.version = "0.3.0";
    await svc.decide(request, { use: "task-size" });
    expect(laya.calls).toBe(4);
  });

  it("does not cache an answer that did not come from Laya", async () => {
    const { svc, laya } = service();
    laya.unavailable = async () => "Laya is down";
    await svc.decide(request, { use: "task-size" });
    await svc.decide(request, { use: "task-size" });
    expect(svc.cache.stats().size).toBe(0);
  });
});

describe("DecisionCache", () => {
  it("forgets an entry after the TTL", () => {
    let now = 0;
    const cache = new DecisionCache(() => now, 1000);
    cache.set("k", { id: "dec_1", answers: {}, trimmed: false });
    now = 999;
    expect(cache.get("k")?.id).toBe("dec_1");
    now = 2000;
    expect(cache.get("k")).toBeUndefined();
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 0 });
  });

  it("keys on question order and on the versions", () => {
    const parse = (options: string[]) => ({
      state: "x",
      questions: {
        q: QuestionSchema.parse({ type: "choice", instructions: "Pick", options }),
      },
    });
    const v = { model: "a", calibration: "0" };
    const a = cacheKey(parse(["one", "two"]), v);
    expect(cacheKey(parse(["two", "one"]), v)).not.toBe(a);
    expect(cacheKey(parse(["one", "two"]), { ...v, calibration: "1" })).not.toBe(a);
    expect(cacheKey(parse(["one", "two"]), v)).toBe(a);
  });
});
