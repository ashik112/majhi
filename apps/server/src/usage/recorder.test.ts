import type { TurnUsage } from "@majhi/acp";
import { describe, expect, it } from "vitest";
import { costTurn } from "./recorder.ts";

const tokens = {
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const turn = (extra: Partial<TurnUsage>): TurnUsage => ({ ...tokens, reported: true, ...extra });

describe("costTurn", () => {
  it("takes a reported cost as real on an API-key account", () => {
    expect(costTurn(turn({ costUsd: 0.5, model: "claude-sonnet-5-5" }), "api-key", {})).toEqual({
      costUsd: 0.5,
      costSource: "reported",
      estimated: false,
    });
  });

  it("marks a reported cost on a sign-in account as the estimated API equivalent", () => {
    expect(costTurn(turn({ costUsd: 0.5 }), "login", {})).toEqual({
      costUsd: 0.5,
      costSource: "reported",
      estimated: true,
    });
  });

  it("prices unreported cost from the table, estimated, with the owner's rows first", () => {
    expect(costTurn(turn({ model: "claude-sonnet-5-5" }), "api-key", {})).toEqual({
      costUsd: 3, // 2 + 1
      costSource: "table",
      estimated: true,
    });
    const owner = { "gpt-5.5": { input: 1, output: 10, cache_read: 0.1, cache_write: 0 } };
    expect(costTurn(turn({ model: "gpt-5.5" }), "login", owner).costUsd).toBeCloseTo(2);
  });

  it("leaves a turn unpriced when there is no report and no price", () => {
    expect(costTurn(turn({ model: "gpt-9" }), "api-key", {})).toEqual({
      costUsd: null,
      costSource: "none",
      estimated: true,
    });
    expect(costTurn(turn({ model: "claude-sonnet-5-5", reported: false }), "login", {}).costSource).toBe(
      "none",
    );
  });
});
