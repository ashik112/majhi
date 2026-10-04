import { type DecideRequest, DecideRequestSchema, type ProviderId } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, runChain } from "./chain.ts";
import type { DecisionProvider } from "./providers.ts";

const request: DecideRequest = DecideRequestSchema.parse({
  state: "Fix a typo",
  questions: { size: { type: "choice", instructions: "How big?", options: ["small", "large"] } },
});
const never = new Promise<never>(() => {});

function fake(id: ProviderId, decide: () => Promise<unknown>): DecisionProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    unavailable: async () => undefined,
    decide: async () => {
      p.calls += 1;
      await decide();
      return { answers: { size: { value: "small", confidence: 0.5 } }, estimated: false, trimmed: false };
    },
  };
  return p;
}

const all = (laya: DecisionProvider, acp: DecisionProvider, rules: DecisionProvider) =>
  ({ laya, jev: fake("jev", async () => {}), acp, rules }) as Record<ProviderId, DecisionProvider>;

describe("chain time budgets", () => {
  it("moves on from a provider that hangs, within its budget", async () => {
    const laya = fake("laya", () => never);
    const rules = fake("rules", async () => {});
    const started = Date.now();
    const result = await runChain(
      ["laya", "rules"],
      all(
        laya,
        fake("acp", () => never),
        rules,
      ),
      request,
      { budgets: { laya: 30 } },
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.provider).toBe("rules");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.provider).toBe("laya");
    expect(result.skipped[0]?.reason).toMatch(/did not answer/);
  });

  it("goes straight to the rules once the chain deadline has passed", async () => {
    const slow = fake("acp", () => never);
    const rules = fake("rules", async () => {});
    const result = await runChain(
      ["acp", "jev", "rules"],
      all(
        fake("laya", async () => {}),
        slow,
        rules,
      ),
      request,
      { budgets: { acp: 40 }, deadlineMs: 40 },
    );
    expect(result.provider).toBe("rules");
    expect(result.skipped.map((s) => s.provider)).toEqual(["acp", "jev"]);
    expect(result.skipped[1]?.reason).toMatch(/ran out of time/);
  });
});

describe("circuit breaker", () => {
  it("skips a provider after repeated failures and tries it again after the cool-down", async () => {
    let now = 1_000;
    const breaker = new CircuitBreaker(2, 60_000, () => now);
    let broken = true;
    const laya = fake("laya", async () => {
      if (broken) throw new Error("laya broke");
    });
    const providers = all(
      laya,
      fake("acp", async () => {}),
      fake("rules", async () => {}),
    );
    const ask = () => runChain(["laya", "rules"], providers, request, { breaker });

    await ask();
    await ask();
    expect(laya.calls).toBe(2);
    expect(breaker.open()).toEqual(["laya"]);

    const skipped = await ask();
    expect(laya.calls).toBe(2);
    expect(skipped.skipped[0]?.reason).toMatch(/failed 2 times in a row/);

    now += 61_000;
    broken = false;
    const back = await ask();
    expect(back.provider).toBe("laya");
    expect(breaker.open()).toEqual([]);
  });

  it("counts a timeout as a failure and a success as a reset", async () => {
    const breaker = new CircuitBreaker(2, 60_000);
    let hang = true;
    const laya = fake("laya", () => (hang ? never : Promise.resolve()));
    const providers = all(
      laya,
      fake("acp", async () => {}),
      fake("rules", async () => {}),
    );
    const opts = { breaker, budgets: { laya: 20 } };
    await runChain(["laya", "rules"], providers, request, opts);
    hang = false;
    await runChain(["laya", "rules"], providers, request, opts);
    hang = true;
    await runChain(["laya", "rules"], providers, request, opts);
    expect(breaker.open()).toEqual([]);
  });

  it("never opens for the rules", () => {
    const breaker = new CircuitBreaker(1);
    breaker.failed("rules");
    expect(breaker.skipReason("rules")).toBeUndefined();
  });
});
