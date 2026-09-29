import { type Price, PriceKeySchema, type PriceRow } from "@majhi/shared";

export const PRICE_FIELDS = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cache_read", label: "Cache read" },
  { key: "cache_write", label: "Cache write" },
] as const satisfies readonly { key: keyof Price; label: string }[];

/** The price form as typed: the model id and four numbers as text. */
export interface PriceDraft {
  model: string;
  input: string;
  output: string;
  cache_read: string;
  cache_write: string;
}

export type PriceDraftErrors = Partial<Record<keyof PriceDraft, string>>;

export const EMPTY_PRICE_DRAFT: PriceDraft = {
  model: "",
  input: "",
  output: "",
  cache_read: "",
  cache_write: "",
};

export function draftFromRow(row: Pick<PriceRow, "model" | "price">): PriceDraft {
  return {
    model: row.model,
    input: String(row.price.input),
    output: String(row.price.output),
    cache_read: String(row.price.cache_read),
    cache_write: String(row.price.cache_write),
  };
}

/** Checks the form. A price is dollars per million tokens, from 0 to 10,000. */
export function parsePriceDraft(
  draft: PriceDraft,
): { ok: true; model: string; price: Price } | { ok: false; errors: PriceDraftErrors } {
  const errors: PriceDraftErrors = {};
  const model = PriceKeySchema.safeParse(draft.model);
  if (!model.success) {
    errors.model =
      draft.model.trim() === "" ? "Enter a model id" : (model.error.issues[0]?.message ?? "Not a model id");
  }
  const price: Price = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  for (const { key } of PRICE_FIELDS) {
    const text = draft[key].trim().replace(/^\$/, "");
    const value = Number(text);
    if (text === "" || !Number.isFinite(value)) errors[key] = "Enter a number";
    else if (value < 0 || value > 10_000) errors[key] = "Use 0 to 10,000";
    else price[key] = value;
  }
  if (!model.success || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, model: model.data, price };
}

/** Owner rows first, then the defaults, each by model id. */
export function sortPriceRows(rows: readonly PriceRow[]): PriceRow[] {
  return [...rows].sort((a, b) =>
    a.source === b.source ? a.model.localeCompare(b.model) : a.source === "owner" ? -1 : 1,
  );
}

/** "$0.25", "$12.50", "$0.075". */
export function formatPrice(usdPerMillion: number): string {
  return `$${usdPerMillion.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}
