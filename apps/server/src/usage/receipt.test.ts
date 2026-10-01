import { cacheHitRate, EMPTY_TOTALS, type UsageTotals } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { agentsOf, compactionsOf, contextOf, decisionsOf, type EventRow, sumTotals } from "./receipt.ts";

function totals(patch: Partial<UsageTotals>): UsageTotals {
  return { ...EMPTY_TOTALS, ...patch };
}

function event(patch: Partial<EventRow>): EventRow {
  return {
    at: "2026-10-01T10:00:00.000Z",
    agent: "builder",
    kind: "recall",
    tokens: 0,
    after_tokens: null,
    method: null,
    ...patch,
  };
}

describe("cache hit rate", () => {
  it("is cache_read over input plus cache_read", () => {
    expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 50 })).toBe(0.75);
  });

  it("is not reported when the agent reported no cache numbers", () => {
    expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });

  it("is a real zero when the cache was written but never read", () => {
    expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 40 })).toBe(0);
  });
});

describe("receipt context sizes", () => {
  it("sums recalls and keeps one brief and memory section", () => {
    const c = contextOf([
      event({ kind: "brief", tokens: 900 }),
      event({ kind: "memory", tokens: 120 }),
      event({ kind: "recall", tokens: 80 }),
      event({ kind: "recall", tokens: 60 }),
    ]);
    expect(c).toEqual({
      briefTokens: 900,
      memoryTokens: 120,
      recallTokens: 140,
      recalls: 2,
      estimated: true,
    });
  });

  it("has no brief size before the brief was sent", () => {
    expect(contextOf([]).briefTokens).toBeNull();
  });
});

describe("compactions", () => {
  it("are native or handoff, oldest first, with unknown sizes kept null", () => {
    const rows = [
      event({
        kind: "compaction",
        at: "2026-10-01T12:00:00.000Z",
        tokens: 164000,
        after_tokens: 18000,
        method: "handoff",
      }),
      event({
        kind: "compaction",
        at: "2026-10-01T11:00:00.000Z",
        tokens: 150000,
        after_tokens: 40000,
        method: "native",
      }),
      event({
        kind: "compaction",
        at: "2026-10-01T13:00:00.000Z",
        tokens: null,
        after_tokens: 9000,
        method: "rotation",
      }),
      event({ kind: "compaction", method: "something-new" }),
      event({ kind: "recall" }),
    ];
    expect(compactionsOf(rows).map((c) => [c.method, c.reason, c.before, c.after])).toEqual([
      ["native", "native", 150000, 40000],
      ["handoff", "handoff", 164000, 18000],
      ["handoff", "rotation", null, 9000],
    ]);
  });
});

describe("decisions that replaced an LLM call", () => {
  const accepted = JSON.stringify({ q: { value: "a", confidence: 0.9, gate: { accepted: true } } });
  const refused = JSON.stringify({ q: { value: "a", confidence: 0.4, gate: { accepted: false } } });

  it("counts local and hosted answers the gate accepted, never the stand-in agent or the rules", () => {
    expect(
      decisionsOf([
        { provider: "laya", answers: accepted },
        { provider: "jev", answers: accepted },
        { provider: "laya", answers: refused },
        { provider: "acp", answers: accepted },
        { provider: "rules", answers: accepted },
        { provider: "laya", answers: "not json" },
      ]),
    ).toEqual({ replaced: 2, total: 6 });
  });
});

describe("per agent split", () => {
  it("adds up to the task total, with each agent's own hit rate", () => {
    const a = totals({ turns: 2, inputTokens: 100, cacheReadTokens: 300, totalTokens: 400, costUsd: 0.5 });
    const b = totals({
      turns: 1,
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      costUsd: 0.1,
      unpricedTurns: 1,
    });
    const agents = agentsOf([
      { key: "builder", totals: a },
      { key: "reviewer", totals: b },
    ]);
    expect(agents.map((x) => [x.agent, x.cacheHitRate])).toEqual([
      ["builder", 0.75],
      ["reviewer", null],
    ]);
    const sum = sumTotals(agents.map((x) => x.totals));
    expect(sum).toMatchObject({
      turns: 3,
      inputTokens: 150,
      outputTokens: 10,
      totalTokens: 460,
      costUsd: 0.6,
      unpricedTurns: 1,
    });
    expect(cacheHitRate(sum)).toBeCloseTo(300 / 450);
  });
});
