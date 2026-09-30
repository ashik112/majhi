import type { OptionValue, PricesConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  effortForTier,
  effortOptions,
  labelModels,
  modelForTier,
  needsEstimate,
  normalizeOffered,
  rankModels,
  rolePhrase,
} from "./model-options.ts";

const opts = (...ids: string[]): OptionValue[] => ids.map((id) => ({ id, name: id }));
const ids = (list: { id: string }[]) => list.map((m) => m.id);

/** What the Claude adapter offered on PRV-32, plus the older versions the CLI keeps listing. */
const CLAUDE = opts(
  "default",
  "sonnet",
  "sonnet[1m]",
  "opus",
  "opus[1m]",
  "haiku",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
);

describe("normalizeOffered", () => {
  it("keeps the newest of each family, without aliases or default (Claude ids)", () => {
    expect(ids(normalizeOffered(CLAUDE))).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
    ]);
  });

  it("groups Codex ids by family and compares dotted versions", () => {
    const codex = opts("gpt-5.3-codex", "gpt-5.5-codex", "gpt-5.5", "gpt-5.4", "gpt-5.5-codex-mini");
    const out = normalizeOffered(codex);
    expect(ids(out)).toEqual(["gpt-5.5-codex", "gpt-5.5", "gpt-5.5-codex-mini"]);
    expect(out.map((m) => m.family)).toEqual(["gpt-codex", "gpt", "gpt-codex-mini"]);
    expect(out[0]?.version).toEqual([5, 5]);
  });

  it("orders versions by number, not by text", () => {
    expect(compareVersions([5, 5], [5])).toBeGreaterThan(0);
    expect(compareVersions([5], [4, 8])).toBeGreaterThan(0);
    expect(compareVersions([4, 10], [4, 9])).toBeGreaterThan(0);
    expect(compareVersions([5, 0], [5])).toBe(0);
    expect(ids(normalizeOffered(opts("m-4-9", "m-4-10", "m-4-8")))).toEqual(["m-4-10"]);
  });

  it("treats a dated snapshot as its version and prefers the plain id on a tie", () => {
    expect(ids(normalizeOffered(opts("claude-opus-4-8-20260101", "claude-opus-4-8")))).toEqual([
      "claude-opus-4-8",
    ]);
    expect(ids(normalizeOffered(opts("claude-opus-4-8-20260101", "claude-opus-4-7")))).toEqual([
      "claude-opus-4-8-20260101",
    ]);
    expect(ids(normalizeOffered(opts("claude-opus-5-5[1m]", "claude-opus-5-5")))).toEqual([
      "claude-opus-5-5",
    ]);
    expect(ids(normalizeOffered(opts("claude-opus-5-latest", "claude-opus-5")))).toEqual(["claude-opus-5"]);
  });

  it("reads a dashed date as a date, not as version numbers", () => {
    const out = normalizeOffered(opts("gpt-5-2026-01-01", "gpt-5.5"));
    expect(ids(out)).toEqual(["gpt-5.5"]);
    expect(ids(normalizeOffered(opts("gpt-5-2026-01-01", "gpt-5")))).toEqual(["gpt-5"]);
    expect(normalizeOffered(opts("gpt-5-2026-01-01"))[0]).toMatchObject({ family: "gpt", version: [5] });
  });

  it("strips a provider prefix", () => {
    expect(ids(normalizeOffered(opts("anthropic/claude-opus-5", "claude-opus-4-8")))).toEqual([
      "anthropic/claude-opus-5",
    ]);
  });

  it("keeps an alias when no versioned model of its family is offered", () => {
    expect(ids(normalizeOffered(opts("default", "sonnet", "opus", "claude-haiku-4-5")))).toEqual([
      "sonnet",
      "opus",
      "claude-haiku-4-5",
    ]);
    expect(ids(normalizeOffered(opts("opus", "opus[1m]")))).toEqual(["opus"]);
  });

  it("drops an alias only when all its words belong to a versioned family", () => {
    expect(ids(normalizeOffered(opts("sonnet", "claude-opus-5")))).toEqual(["sonnet", "claude-opus-5"]);
  });

  it("drops default whenever anything else is offered, and keeps it alone", () => {
    expect(ids(normalizeOffered(opts("default", "a-1")))).toEqual(["a-1"]);
    expect(ids(normalizeOffered(opts("default")))).toEqual(["default"]);
    expect(normalizeOffered([])).toEqual([]);
  });

  it("merges the list codex-cli 0.158.0 offers", () => {
    const ids = [
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ];
    const out = normalizeOffered(ids.map((id) => ({ id, name: id })));
    expect(out.map((m) => [m.id, m.family])).toEqual([
      ["gpt-6-astra", "gpt-astra"],
      ["gpt-6-sol", "gpt-sol"],
      ["gpt-6-luna", "gpt-luna"],
      ["gpt-5.6-terra", "gpt-terra"],
      ["gpt-5.5", "gpt"],
    ]);
  });

  it("keeps the CLI description for unpriced models", () => {
    const out = normalizeOffered([{ id: "gpt-5.5", name: "x", description: "  Fast  " }]);
    expect(out[0]?.description).toBe("Fast");
  });
});

const OWNER: PricesConfig = {
  "gpt-5.5-codex": { input: 2, output: 12, cache_read: 0.2, cache_write: 0 },
  "gpt-5.5": { input: 1, output: 8, cache_read: 0.1, cache_write: 0 },
  "gpt-5.5-codex-mini": { input: 0.3, output: 2, cache_read: 0.03, cache_write: 0 },
};
const price = (output: number, input = 1) => ({ input, output, cache_read: 0, cache_write: 0 });

describe("labelModels", () => {
  it("labels by price rank from the default table", () => {
    const labels = labelModels(normalizeOffered(CLAUDE));
    const byId = Object.fromEntries(labels.map((l) => [l.id, l]));
    expect(byId["claude-fable-5-1"]).toMatchObject({
      rank: "most capable",
      label: "claude-fable-5-1: most capable",
    });
    expect(byId["claude-haiku-4-5"]).toMatchObject({
      rank: "cheapest and fastest",
      label: "claude-haiku-4-5: cheapest and fastest",
    });
    expect(byId["claude-opus-5-5"]?.rank).toBe("balanced");
    expect(byId["claude-sonnet-5-5"]?.rank).toBe("balanced");
  });

  it("uses the owner's rows when every model is priced", () => {
    const models = normalizeOffered(opts("gpt-5.5-codex", "gpt-5.5-codex-mini"));
    expect(labelModels(models, OWNER).map((l) => l.label)).toEqual([
      "gpt-5.5-codex: most capable",
      "gpt-5.5-codex-mini: cheapest and fastest",
    ]);
  });

  it("reads the CLI description for every model when one has no price", () => {
    const models = normalizeOffered([
      { id: "gpt-5.5-codex", name: "a", description: "Marketing text" },
      { id: "gpt-5.5-codex-mini", name: "b" },
      { id: "other-9", name: "c", description: "Unknown to the table" },
    ]);
    const labels = labelModels(models, OWNER);
    expect(labels.map((l) => l.label)).toEqual([
      "gpt-5.5-codex: Marketing text",
      "gpt-5.5-codex-mini",
      "other-9: Unknown to the table",
    ]);
    expect(labels.every((l) => l.rank === undefined)).toBe(true);
  });

  it("gives a model with no price its CLI text", () => {
    const models = normalizeOffered([
      { id: "acme-code-5", name: "a", description: "Best for code" },
      { id: "acme-fast-1", name: "b" },
    ]);
    expect(labelModels(models).map((l) => l.label)).toEqual(["acme-code-5: Best for code", "acme-fast-1"]);
  });

  it("gives equal prices the same label", () => {
    const rows = { "a-1": price(5), "b-1": price(5), "c-1": price(20) };
    const labels = labelModels(normalizeOffered(opts("a-1", "b-1", "c-1")), rows);
    expect(labels.map((l) => l.rank)).toEqual([
      "cheapest and fastest",
      "cheapest and fastest",
      "most capable",
    ]);
    const same = labelModels(normalizeOffered(opts("a-1", "b-1")), { "a-1": price(5), "b-1": price(5) });
    expect(same.map((l) => l.rank)).toEqual(["balanced", "balanced"]);
  });

  it("breaks an output price tie on the input price", () => {
    const rows = { "a-1": price(5, 1), "b-1": price(5, 3) };
    expect(labelModels(normalizeOffered(opts("a-1", "b-1")), rows).map((l) => l.rank)).toEqual([
      "cheapest and fastest",
      "most capable",
    ]);
  });

  it("cuts a long description to 200 characters", () => {
    const [only] = labelModels(normalizeOffered([{ id: "x-1", name: "x", description: "d".repeat(400) }]));
    expect(only?.label).toHaveLength(200);
  });
});

describe("modelForTier", () => {
  it("picks by price rank: first, last, and the lower middle", () => {
    const four = normalizeOffered(opts("a-1", "b-1", "c-1", "d-1"));
    const p = { "a-1": price(4), "b-1": price(1), "c-1": price(3), "d-1": price(2) };
    expect(modelForTier(four, "cheapest", p)).toBe("b-1");
    expect(modelForTier(four, "most-capable", p)).toBe("a-1");
    expect(modelForTier(four, "balanced", p)).toBe("d-1");
    const three = four.slice(0, 3);
    expect(modelForTier(three, "balanced", p)).toBe("c-1");
  });

  it("estimates the rank from the CLI order when a model has no price: most capable first", () => {
    const models = normalizeOffered(opts("a-1", "b-1", "c-1", "d-1"));
    expect(modelForTier(models, "most-capable")).toBe("a-1");
    expect(modelForTier(models, "cheapest")).toBe("d-1");
    expect(modelForTier(models, "balanced")).toBe("c-1");
    expect(modelForTier(models, "most-capable", { "a-1": price(1) })).toBe("a-1");
    expect(modelForTier([], "cheapest")).toBeUndefined();
  });

  it("labels an estimated rank from the CLI's order, dearest first", () => {
    const models = normalizeOffered(opts("a-1", "b-1", "c-1"));
    const rank = rankModels(models);
    expect(rank.order).toEqual(["c-1", "b-1", "a-1"]);
    expect(rank.estimated).toBe(true);
    expect([...rank.labels]).toEqual([
      ["a-1", "most capable"],
      ["b-1", "balanced"],
      ["c-1", "cheapest and fastest"],
    ]);
  });

  it("does not estimate when every model has a price", () => {
    const models = normalizeOffered(opts("a-1", "b-1"));
    const p = { "a-1": price(9), "b-1": price(1) };
    const rank = rankModels(models, p);
    expect(rank.estimated).toBe(false);
    expect(rank.order).toEqual(["b-1", "a-1"]);
    expect(needsEstimate(models, p)).toBe(false);
    expect(needsEstimate(models, { "a-1": price(9) })).toBe(true);
  });

  it("resolves the default table for the Claude list", () => {
    const models = normalizeOffered(CLAUDE);
    expect(modelForTier(models, "most-capable")).toBe("claude-fable-5-1");
    expect(modelForTier(models, "cheapest")).toBe("claude-haiku-4-5");
    expect(modelForTier(models, "balanced")).toBe("claude-sonnet-5-5");
  });
});

describe("effortForTier", () => {
  const efforts = (...list: string[]) => opts(...list);

  it("takes the first, the last and the upper middle of the CLI's order", () => {
    const five = efforts("low", "medium", "high", "xhigh", "max");
    expect(effortForTier(five, "lowest")).toBe("low");
    expect(effortForTier(five, "highest")).toBe("max");
    expect(effortForTier(five, "middle")).toBe("high");
    const three = efforts("low", "medium", "high");
    expect(effortForTier(three, "middle")).toBe("medium");
    const four = efforts("low", "medium", "high", "xhigh");
    expect(effortForTier(four, "middle")).toBe("high");
    const two = efforts("low", "high");
    expect(effortForTier(two, "middle")).toBe("high");
  });

  it("ignores default, and resolves nothing from an empty list", () => {
    expect(effortForTier(efforts("default", "low", "medium", "high"), "lowest")).toBe("low");
    expect(effortForTier(efforts("default"), "highest")).toBeUndefined();
    expect(effortForTier([], "lowest")).toBeUndefined();
    expect(effortOptions(efforts("default", "low")).map((o) => o.id)).toEqual(["low"]);
  });

  it("does not depend on effort names", () => {
    expect(effortForTier(efforts("minimal", "balanced", "deep"), "highest")).toBe("deep");
  });
});

describe("rolePhrase", () => {
  it("says what the role does", () => {
    expect(rolePhrase("Lead")).toBe("a Lead who plans and reviews the work");
  });
});
