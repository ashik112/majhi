import type { AccountUsage, AccountView } from "@majhi/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useRefreshUsage } from "@/lib/studio-queries";
import { formatPct, resetFull, type Tone, usageRows, usageRowText, usageTone } from "./model";

const BAR: Record<Tone, string> = {
  green: "bg-green",
  amber: "bg-amber",
  red: "bg-red",
  neutral: "bg-fg-muted",
};

/** A thin bar, filled to `pct`. The number next to it carries the meaning; color only adds urgency. */
function Bar({ pct, tone }: { pct: number; tone: Tone }) {
  return (
    <span aria-hidden="true" className="block h-1 w-full overflow-hidden rounded-full bg-line-strong">
      <span
        className={cn("block h-full rounded-full", BAR[tone])}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </span>
  );
}

/** The usage cell of the table: two compact rows, `5h 42% · 9:30 PM` and `Week 18% · Thu`. */
export function UsageCell({ account, now }: { account: AccountView; now: number }) {
  if (account.auth === "api-key") return <span className="text-sm text-fg-faint">After first run</span>;
  const rows = usageRows(account.usage, now);
  if (rows.length === 0) {
    return (
      <span className="text-sm text-fg-faint">
        {account.usage?.error === undefined ? "No usage yet" : "Usage unavailable"}
      </span>
    );
  }
  return (
    <div className="flex w-40 flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-0.5">
          <span className={cn("text-sm whitespace-nowrap", toneText(row.tone))}>{usageRowText(row)}</span>
          <Bar pct={row.pct} tone={row.tone} />
        </div>
      ))}
    </div>
  );
}

/** Text color for a tone; calm tones keep the default color. */
function toneText(tone: Tone): string {
  return tone === "red" ? "text-red" : tone === "amber" ? "text-amber" : "text-fg-soft";
}

function WindowLine({
  label,
  window,
}: {
  label: string;
  window: { usedPct: number; resetsAt?: string | undefined };
}) {
  const tone = usageTone(window.usedPct);
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-baseline gap-2 text-sm">
        <span className="text-fg-soft">{label}</span>
        <span className={cn("tabular-nums", toneText(tone))}>{formatPct(window.usedPct)}</span>
        {window.resetsAt && (
          <span className="ml-auto text-fg-faint">resets {resetFull(window.resetsAt)}</span>
        )}
      </span>
      <Bar pct={window.usedPct} tone={tone} />
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
      {usage?.window && <WindowLine label="5-hour window" window={usage.window} />}
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
