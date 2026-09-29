import { describe, expect, it } from "vitest";
import { TurnMeter } from "./turn-usage.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, thought = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cachedReadTokens: cacheRead,
  cachedWriteTokens: cacheWrite,
  thoughtTokens: thought,
});

describe("TurnMeter", () => {
  it("takes per-turn counts as they are", () => {
    const m = new TurnMeter("turn");
    m.begin();
    expect(m.end(usage(100, 20, 300, 40, 5), "sonnet")).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
      reported: true,
      model: "sonnet",
    });
    m.begin();
    expect(m.end(usage(10, 2), undefined)).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
    });
  });

  it("turns running totals into per-turn deltas and starts over when a total drops", () => {
    const m = new TurnMeter("cumulative");
    m.begin();
    expect(m.end(usage(100, 20), undefined)).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    m.begin();
    expect(m.end(usage(250, 50, 10), undefined)).toMatchObject({
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 10,
    });
    m.begin();
    // A new process reports from zero again.
    expect(m.end(usage(40, 5), undefined)).toMatchObject({ inputTokens: 40, outputTokens: 5 });
  });

  it("marks a turn without usage as not reported, with zero tokens", () => {
    const m = new TurnMeter("turn");
    m.begin();
    expect(m.end(undefined, undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reported: false,
    });
  });

  it("charges a turn what the running cost grew by while it ran", () => {
    const m = new TurnMeter("turn");
    m.begin();
    m.note({ cost: { amount: 0.02, currency: "USD" }, model: "claude-sonnet-5-5" });
    m.note({ cost: { amount: 0.05, currency: "USD" } });
    expect(m.end(usage(1, 1), "sonnet")).toMatchObject({ costUsd: 0.05, model: "claude-sonnet-5-5" });
    // A cost report between turns (background work) is not billed to the next turn.
    m.note({ cost: { amount: 0.07, currency: "USD" } });
    m.begin();
    m.note({ cost: { amount: 0.1, currency: "USD" } });
    expect(m.end(usage(1, 1), "sonnet").costUsd).toBeCloseTo(0.03);
  });

  it("has no cost for a turn without a cost report, or with a non-USD one", () => {
    const m = new TurnMeter("turn");
    m.begin();
    m.note({ cost: { amount: 1, currency: "USD" } });
    m.end(usage(1, 1), undefined);
    m.begin();
    expect(m.end(usage(1, 1), undefined).costUsd).toBeUndefined();
    m.begin();
    m.note({ cost: { amount: 3, currency: "EUR" } });
    expect(m.end(usage(1, 1), undefined).costUsd).toBeUndefined();
  });

  it("takes a running cost that went down as a restart", () => {
    const m = new TurnMeter("turn");
    m.begin();
    m.note({ cost: { amount: 0.5, currency: "USD" } });
    m.end(usage(1, 1), undefined);
    m.begin();
    m.note({ cost: { amount: 0.04, currency: "USD" } });
    expect(m.end(usage(1, 1), undefined).costUsd).toBe(0.04);
  });
});
