import type { AccountView, UsageTotals } from "@majhi/shared";
import { UsageBar } from "@/components/ui/usage-bar";
import { CostText } from "@/features/usage/cost";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";
import { formatPct, resetFull, resetLabel, usageTone } from "./model";

/** A calm bar while there is room, amber from 80 %, red when full. */
export function meterTone(pct: number): "calm" | "amber" | "red" {
  const tone = usageTone(pct);
  return tone === "amber" || tone === "red" ? tone : "calm";
}

const PCT_TEXT = { calm: "text-fg", amber: "text-amber", red: "text-red" } as const;

/**
 * One usage window of an account: its name, the share used in mono, when it resets, and a thin bar.
 * The number carries the meaning; the bar only shows it at a glance.
 */
export function WindowMeter({
  label,
  window,
  now,
  className,
}: {
  label: string;
  window: { usedPct: number; resetsAt?: string | undefined };
  now: number;
  className?: string;
}) {
  const tone = meterTone(window.usedPct);
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="shrink-0 text-fg-muted">{label}</span>
        <span className={cn("tnum font-mono", PCT_TEXT[tone])}>{formatPct(window.usedPct)}</span>
        {window.resetsAt && (
          <span
            title={`Resets ${resetFull(window.resetsAt)}`}
            className="ml-auto truncate text-xs text-fg-faint"
          >
            resets {resetLabel(window.resetsAt, now)}
          </span>
        )}
      </span>
      <UsageBar pct={window.usedPct} tone={tone} height={4} />
    </div>
  );
}

/**
 * The windows an account reports: the 5-hour one, the week, and any per-model weekly ones. API-key
 * accounts pay per token and have no windows, so they get what they spent instead.
 */
export function AccountMeters({
  account,
  now,
  spend,
  className,
}: {
  account: AccountView;
  now: number;
  /** API-key accounts only: tokens and cost this week. Null when nothing ran, undefined while loading. */
  spend?: UsageTotals | null | undefined;
  className?: string;
}) {
  if (account.auth === "api-key") {
    return (
      <p className={cn("text-sm text-fg-muted", className)}>
        Pays per token, no usage windows.
        {spend && spend.turns > 0 && (
          <span className="ml-1 text-fg-soft">
            <CostText totals={spend} /> and {formatTokens(spend.totalTokens)} tokens this week.
          </span>
        )}
      </p>
    );
  }
  const usage = account.usage;
  if (account.status === "needs-login") {
    return <p className={cn("text-sm text-fg-faint", className)}>Signed out. Sign in to read usage.</p>;
  }
  if (!usage?.window && !usage?.weekly) {
    return (
      <p className={cn("text-sm text-fg-faint", className)}>
        {usage?.error ? "Usage unavailable. Run a health check to read it again." : "No usage read yet."}
      </p>
    );
  }
  return (
    <div className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      {usage.window && <WindowMeter label="5 hours" window={usage.window} now={now} />}
      {usage.weekly && <WindowMeter label="Week" window={usage.weekly} now={now} />}
      {usage.models.map((m) => (
        <WindowMeter key={m.label} label={`Week, ${m.label}`} window={m} now={now} />
      ))}
    </div>
  );
}
