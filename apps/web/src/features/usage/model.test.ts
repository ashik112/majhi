import { describe, expect, it } from "vitest";
import { parsePriceDraft, sortPriceRows } from "./model";

const draft = { model: " GPT-5.5 ", input: "1.25", output: "$10", cache_read: "0.125", cache_write: "0" };

describe("parsePriceDraft", () => {
  it("reads the model id and four prices", () => {
    expect(parsePriceDraft(draft)).toEqual({
      ok: true,
      model: "gpt-5.5",
      price: { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
    });
  });

  it("refuses blanks, negatives and bad ids, and never guesses a zero", () => {
    const result = parsePriceDraft({
      model: "",
      input: "",
      output: "-1",
      cache_read: "abc",
      cache_write: "20000",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual([
      "cache_read",
      "cache_write",
      "input",
      "model",
      "output",
    ]);
    expect(parsePriceDraft({ ...draft, model: "no spaces please" }).ok).toBe(false);
  });
});

describe("sortPriceRows", () => {
  it("puts the owner's rows first", () => {
    const price = { input: 1, output: 1, cache_read: 1, cache_write: 1 };
    const rows = sortPriceRows([
      { model: "b", price, source: "default", overridesDefault: false },
      { model: "z", price, source: "owner", overridesDefault: false },
      { model: "a", price, source: "default", overridesDefault: false },
    ]);
    expect(rows.map((r) => r.model)).toEqual(["z", "a", "b"]);
  });
});
