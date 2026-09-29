import type { AccountUsage, AccountView } from "@majhi/shared";
import { Button } from "@/components/ui/button";
import { toneText } from "@/components/ui/status-dot";
import { UsageBar } from "@/components/ui/usage-bar";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useRefreshUsage } from "@/lib/studio-queries";
import { barTone, formatPct, resetFull } from "./model";

/** One usage window: label, share used, full reset time and a bar. */
export function WindowLine({
  label,
  window,
}: {
  label: string;
  window: { usedPct: number; resetsAt?: string | undefined };
}) {
  const tone = barTone(window.usedPct);
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-baseline gap-2 text-sm">
        <span className="text-fg-soft">{label}</span>
        <span className={cn("tabular-nums", toneText(tone))}>{formatPct(window.usedPct)}</span>
        {window.resetsAt && (
          <span className="ml-auto text-fg-faint">resets {resetFull(window.resetsAt)}</span>
        )}
      </span>
      <UsageBar pct={window.usedPct} tone={barTone(window.usedPct)} height={4} />
    </div>
  );
}

/** Usage in the details panel: plan, both windows with full reset times, model windows, read time and Refresh. */
export function UsageDetails({ account, now }: { account: AccountView; now: number }) {
  const refresh = useRefreshUsage();
  if (account.auth === "api-key") {
    return <span className="text-fg-faint">Tokens and cost show after the first run</span>;
  }
  const usage: AccountUsage | undefined = account.usage;
  const hasWindows = usage?.window !== undefined || usage?.weekly !== undefined;
  const error = refresh.isError ? describeError(refresh.error) : usage?.error;
  return (
    <div className="flex flex-col gap-2.5">
      {usage?.plan && <span className="text-sm text-fg-soft">Plan: {usage.plan}</span>}
      {usage?.window && <WindowLine label="Current window" window={usage.window} />}
      {usage?.weekly && <WindowLine label="Week" window={usage.weekly} />}
      {usage?.models.map((m) => (
        <WindowLine key={m.label} label={`Week, ${m.label}`} window={m} />
      ))}
      {!hasWindows && <span className="text-fg-faint">No usage yet</span>}
      {error && (
        <p role="alert" className="text-sm text-red">
          Last read failed: {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => refresh.mutate(account.id)} disabled={refresh.isPending}>
          {refresh.isPending ? "Reading" : "Refresh"}
        </Button>
        {usage && hasWindows && (
          <span className="text-sm text-fg-faint">Read {formatAgo(usage.updatedAt, now)}</span>
        )}
      </div>
    </div>
  );
}
