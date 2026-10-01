import { addDays } from "../usage/ranges.ts";
import type { FiredAlert } from "./monitor.ts";

function tokens(n: number): string {
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `${Number((n / 1e3).toFixed(n >= 1e4 ? 0 : 1))}k`;
  return String(n);
}

function dollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** The quiet room line for an alert. The 100% one is a warning. */
export function alertLine(a: FiredAlert): { text: string; level: "info" | "warn" } {
  const who = `${a.scope} ${a.id}`;
  const percent = Math.floor(a.percent);
  const amount =
    a.measure === "tokens"
      ? `${tokens(a.spend.tokens)} of ${tokens(a.budget.tokens ?? 0)} tokens`
      : `${dollars(a.spend.cost)} of ${dollars(a.budget.cost ?? 0)}`;
  const resets = `The week resets Monday ${addDays(a.week.weekStart, 7)}.`;
  return a.threshold === 100
    ? {
        level: "warn",
        text: `Budget limit reached: ${who} is at ${percent}% of its weekly budget (${amount}). ${resets}`,
      }
    : {
        level: "info",
        text: `Budget alert: ${who} is at ${percent}% of its weekly budget (${amount}). ${resets}`,
      };
}
