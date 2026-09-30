import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICE_SOURCES,
  DEFAULT_PRICES,
  findPrice,
  normalizeModel,
  priceTokens,
  totalTokens,
} from "./usage.ts";

describe("findPrice", () => {
  it("matches an exact id, a dated snapshot and a context suffix", () => {
    expect(findPrice("claude-sonnet-5-5")?.key).toBe("claude-sonnet-5-5");
    expect(findPrice("claude-opus-4-8-20260101")?.key).toBe("claude-opus-4-8");
    expect(findPrice("claude-sonnet-5-5[1m]")?.key).toBe("claude-sonnet-5-5");
    expect(findPrice("anthropic.claude-haiku-4-5")?.key).toBe("claude-haiku-4-5");
  });

  it("never prices a newer model with an older family's row", () => {
    expect(findPrice("claude-sonnet-5-6")).toBeUndefined();
    expect(findPrice("claude-opus-5-5")?.key).toBe("claude-opus-5-5");
    expect(findPrice("claude-opus-5-20260301")?.key).toBe("claude-opus-5");
  });

  it("has no row for aliases, unknown models or nothing", () => {
    expect(findPrice("sonnet")).toBeUndefined();
    expect(findPrice("gpt-9")).toBeUndefined();
    expect(findPrice("gpt-6")).toBeUndefined();
    expect(findPrice(undefined)).toBeUndefined();
    expect(findPrice("  ")).toBeUndefined();
  });

  it("uses the owner's rows, and they win over a default with the same key", () => {
    const owner = {
      "gpt-5.5": { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
      "claude-haiku-4-5": { input: 2, output: 8, cache_read: 0.2, cache_write: 2.5 },
    };
    expect(findPrice("gpt-5.5", owner)).toMatchObject({ key: "gpt-5.5", source: "owner" });
    expect(findPrice("claude-haiku-4-5", owner)).toMatchObject({ source: "owner", price: { input: 2 } });
    expect(findPrice("GPT-5.5", owner)?.key).toBe("gpt-5.5");
  });

  it("normalizes case, suffixes and provider prefixes", () => {
    expect(normalizeModel(" Claude-Opus-5-5[1M] ")).toBe("claude-opus-5-5");
    expect(normalizeModel("openai/gpt-5.5")).toBe("gpt-5.5");
  });
});

describe("default rows", () => {
  it("prices the Codex models, and each default row has a page and a check date", () => {
    for (const id of [
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]) {
      expect(findPrice(id)?.source).toBe("default");
    }
    // The family names a model shares with a longer id do not borrow its row.
    expect(findPrice("gpt-5.5-codex")).toBeUndefined();
    expect(findPrice("gpt-6-sol-mini")).toBeUndefined();
    expect(DEFAULT_PRICES["gpt-5.5"]).toEqual({ input: 5, output: 30, cache_read: 0.5, cache_write: 0 });
    expect(Object.keys(DEFAULT_PRICE_SOURCES).sort()).toEqual(Object.keys(DEFAULT_PRICES).sort());
    for (const source of Object.values(DEFAULT_PRICE_SOURCES)) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("priceTokens", () => {
  it("charges each kind of token at its own rate, per million", () => {
    const t = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      reasoningTokens: 50_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 400_000,
    };
    const p = DEFAULT_PRICES["claude-sonnet-5-5"];
    if (p === undefined) throw new Error("missing default");
    // 2 + 1 + 0.4 + 1 = 4.4; reasoning is part of output, not charged again.
    expect(priceTokens(t, p)).toBeCloseTo(4.4);
    expect(totalTokens(t)).toBe(3_500_000);
  });
});
