import {
  type Answer,
  answerChoices,
  type DecideRequest,
  DecideRequestSchema,
  type ProviderId,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { fakeLaya, type LayaScript, service, sure } from "../testkit.ts";
import { askOpinion, MIN_ACT } from "./common.ts";
import { LAYA_USE_SLOTS } from "./slots.ts";

/** The shared way the cheap Laya uses ask: Laya only, a hard time limit, garbage and the rules ignored. */

const live = LAYA_USE_SLOTS.map((s) => ({ ...s, startMode: "live" as const }));
const request = {
  state: "x",
  questions: {
    pick: { type: "choice" as const, instructions: "Which?", options: ["a", "b"] },
  },
};
const says =
  (value: string, p: number): LayaScript =>
  async (r: DecideRequest) =>
    Object.fromEntries(Object.entries(r.questions).map(([k, q]) => [k, sure(q, value, p)]));

describe("askOpinion", () => {
  it("is undefined with no decision provider at all", async () => {
    expect(await askOpinion(undefined, request, "captain", "pick", ["a", "b"])).toBeUndefined();
  });

  it("never reaches a paid model when Laya is down: only Laya is tried, then the rules, whose guess is dropped", async () => {
    const down = fakeLaya({
      script: async () => {
        throw new Error("Laya is down");
      },
    });
    let paid = 0;
    const acp = {
      id: "acp" as const,
      unavailable: async () => undefined,
      decide: async () => {
        paid += 1;
        return { answers: {}, estimated: true, trimmed: false };
      },
    };
    const { svc } = service(down, acp, live);
    expect(await askOpinion(svc, request, "captain", "pick", ["a", "b"])).toBeUndefined();
    expect(paid).toBe(0);
  });

  it("gives up on a Laya that is slow, within the time it was given", async () => {
    const slow = fakeLaya({ script: () => new Promise<Record<string, Answer>>(() => {}) });
    const { svc } = service(slow, undefined, live);
    const started = performance.now();
    const got = await askOpinion(svc, request, "captain", "pick", ["a", "b"], { timeoutMs: 80 });
    expect(got).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("drops an answer that is not one of the options, and a probability that is not a number", async () => {
    const garbage = fakeLaya({
      script: async () => ({ pick: { value: "banana", confidence: 0.99, probabilities: { banana: 0.99 } } }),
    });
    expect(
      await askOpinion(service(garbage, undefined, live).svc, request, "captain", "pick", ["a", "b"]),
    ).toBeUndefined();
    const nan = fakeLaya({
      script: async () => ({ pick: { value: "a", confidence: Number.NaN } as Answer }),
    });
    expect(
      await askOpinion(service(nan, undefined, live).svc, request, "captain", "pick", ["a", "b"]),
    ).toBeUndefined();
  });

  it("acts at exactly the bar and not a hair under it", async () => {
    const slot = {
      id: "pick",
      title: "Pick",
      use: "captain" as const,
      question: /^pick$/,
      target: 0.9,
      startMode: "live" as const,
    };
    const at = await askOpinion(
      service(fakeLaya({ script: says("a", MIN_ACT) }), undefined, [slot]).svc,
      request,
      "captain",
      "pick",
      ["a", "b"],
    );
    expect(at).toMatchObject({ value: "a", acts: true });
    const under = await askOpinion(
      service(fakeLaya({ script: says("a", 0.8999) }), undefined, [slot]).svc,
      request,
      "captain",
      "pick",
      ["a", "b"],
    );
    expect(under).toMatchObject({ value: "a", acts: false });
  });

  it("never acts in shadow, however sure Laya is", async () => {
    const slot = { id: "pick", title: "Pick", use: "captain" as const, question: /^pick$/, target: 0.9 };
    const got = await askOpinion(
      service(fakeLaya({ script: says("a", 0.999) }), undefined, [slot]).svc,
      request,
      "captain",
      "pick",
      ["a", "b"],
    );
    expect(got).toMatchObject({ value: "a", shadow: true, acts: false });
  });

  it("does not trust an answer from a provider it was not told to trust", async () => {
    const down = fakeLaya({
      script: async () => {
        throw new Error("down");
      },
    });
    const acp = {
      id: "acp" as const,
      unavailable: async () => undefined,
      decide: async (r: DecideRequest) => ({
        answers: Object.fromEntries(Object.entries(r.questions).map(([k, q]) => [k, sure(q, "a", 0.99)])),
        estimated: true,
        trimmed: false,
      }),
    };
    const { svc } = service(down, acp, live);
    const got = await askOpinion(svc, request, "captain", "pick", ["a", "b"], {
      order: ["laya", "acp"] as ProviderId[],
      trust: ["laya"],
    });
    expect(got).toMatchObject({ provider: "acp", acts: false });
  });
});

describe("the order and the daily budget of a call", () => {
  it("counts the answers of the day in the log and stops at the cap", async () => {
    const acp = {
      id: "acp" as const,
      unavailable: async () => undefined,
      decide: async (r: DecideRequest) => ({
        answers: Object.fromEntries(Object.entries(r.questions).map(([k, q]) => [k, sure(q, "a", 0.9)])),
        estimated: true,
        trimmed: false,
      }),
    };
    const { svc } = service(fakeLaya(), acp, live);
    const ask = (n: number) =>
      svc.decide(
        { state: `call ${n}`, questions: request.questions },
        { use: "memory", order: ["acp"], perDay: 2 },
      );
    expect((await ask(1)).provider).toBe("acp");
    expect((await ask(2)).provider).toBe("acp");
    await expect(ask(3)).rejects.toThrow(/daily budget of 2 acp answers/);
    // Laya's own calls are not counted against the stand-in's budget.
    expect(
      (await svc.decide({ state: "other", questions: request.questions }, { use: "memory" })).provider,
    ).toBe("laya");
  });
});

describe("the built-in examples of the Laya uses", () => {
  it.each(LAYA_USE_SLOTS.map((s) => [s.id, s] as const))(
    "%s: every example is a valid request with a label it can be answered with",
    (_id, slot) => {
      const fixtures = slot.fixtures?.() ?? [];
      expect(fixtures.length).toBeGreaterThanOrEqual(10);
      const labels = new Set<string>();
      for (const f of fixtures) {
        const parsed = DecideRequestSchema.parse(f.request);
        const q = parsed.questions[f.question];
        expect(q, `question ${f.question}`).toBeDefined();
        expect(slot.question.test(f.question)).toBe(true);
        if (q !== undefined) expect(answerChoices(q)).toContain(f.label);
        labels.add(f.label);
      }
      // Both sides are covered, so a provider that always says the same thing is caught.
      expect(labels.size).toBeGreaterThanOrEqual(2);
    },
  );
});
