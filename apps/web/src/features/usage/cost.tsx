import type { UsageTotals } from "@majhi/shared";
import { cn } from "@/lib/cn";
import { formatMoney, plural } from "@/lib/format";

const WHY_ESTIMATED =
  "Sign-in accounts show what the same tokens would cost on the API, and turns priced from the price table are estimates.";

/** The tooltip for an amount with an estimated part. */
export function estimatedTitle(totals: Pick<UsageTotals, "costUsd" | "estimatedUsd">): string {
  const all = totals.estimatedUsd >= totals.costUsd - 0.000_001;
  const lead = all
    ? "Estimated."
    : `${formatMoney(totals.estimatedUsd)} of ${formatMoney(totals.costUsd)} is estimated.`;
  return `${lead} ${WHY_ESTIMATED}`;
}

/** "est.", with a tooltip and a spoken form that say why. */
export function EstLabel({
  totals,
  className,
}: {
  totals: Pick<UsageTotals, "costUsd" | "estimatedUsd">;
  className?: string;
}) {
  if (totals.estimatedUsd <= 0) return null;
  const title = estimatedTitle(totals);
  return (
    <abbr
      title={title}
      className={cn("cursor-help text-xs font-normal text-fg-faint no-underline", className)}
    >
      <span aria-hidden="true">est.</span>
      <span className="sr-only">{title}</span>
    </abbr>
  );
}

/** "$4.20 est." Tabular figures for columns; `proportional` for a standalone headline number. */
export function CostText({
  totals,
  proportional = false,
  className,
}: {
  totals: Pick<UsageTotals, "costUsd" | "estimatedUsd">;
  proportional?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-baseline gap-1", className)}>
      <span className={cn(!proportional && "tabular-nums")}>{formatMoney(totals.costUsd)}</span>
      <EstLabel totals={totals} />
    </span>
  );
}

/** "3 turns have no price." or nothing. */
export function unpricedText(totals: Pick<UsageTotals, "unpricedTurns">): string | undefined {
  const n = totals.unpricedTurns;
  if (n <= 0) return undefined;
  return `${plural(n, "turn")} ${n === 1 ? "has" : "have"} no price.`;
}
