import type { BudgetRow } from "@majhi/shared";

/** Bar and text colors: amber from 80%, red from 100%. */
export function budgetTone(percent: number): "green" | "amber" | "red" {
  return percent >= 100 ? "red" : percent >= 80 ? "amber" : "green";
}

/** "500k", "2M", "1.5m", "1,500,000" or "1500000" as a token count. Undefined when it is not one. */
export function parseTokens(text: string): number | undefined {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kKmMbB]?)$/.exec(text.trim().replace(/[,_ ]/g, ""));
  if (!match) return undefined;
  const unit = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? "").toLowerCase()] ?? 1;
  const n = Math.round(Number(match[1]) * unit);
  return n >= 1 ? n : undefined;
}

/** Dollars as typed, `12`, `12.5` or `$12.50`. Undefined when it is not a positive amount. */
export function parseDollars(text: string): number | undefined {
  const match = /^\$?([0-9]+(?:\.[0-9]+)?)$/.exec(text.trim().replace(/,/g, ""));
  const n = match ? Number(match[1]) : Number.NaN;
  return n > 0 ? n : undefined;
}

/** What the budgets over 100% are, for the banner. */
export function overBudget(rows: readonly BudgetRow[]): BudgetRow[] {
  return rows.filter((r) => r.percent >= 100);
}
