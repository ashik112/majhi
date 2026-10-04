import type { AutonomyStatus, CaptainStatus } from "@majhi/shared";
import { BarChart3, History, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { capTone } from "@/features/autonomy/model";
import { useAutonomousSwitch } from "@/features/autonomy/switch";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useMoney } from "@/lib/scorecard-queries";
import { chipLine } from "./summary";

/** Whole dollars from $10 up, cents below. */
function dollars(n: number): string {
  return n >= 10 || Number.isInteger(n) ? `$${Math.round(n).toLocaleString("en-US")}` : formatMoney(n);
}

/**
 * The top of the Captain page, one slim bar: the Auto-pilot switch, today's and this month's spend,
 * yesterday's chip, and the Permissions, Results and History buttons.
 */
export function CaptainHeader({
  captain,
  autonomy,
  now,
  onPermissions,
  onSummary,
  onResults,
  onHistory,
}: {
  /** Undefined while `captain.status` loads: the header draws at once and fills in. */
  captain: CaptainStatus | undefined;
  autonomy: AutonomyStatus | undefined;
  now: number;
  onPermissions: () => void;
  onSummary: () => void;
  onResults: () => void;
  onHistory: () => void;
}) {
  const { toggle, dialogs, unavailable } = useAutonomousSwitch();
  const month = useMoney().data;
  const total = autonomy?.spend.total;
  const cap = total?.cap?.cost;
  const summary = autonomy?.summary;
  const chip = summary === undefined ? undefined : chipLine(summary, now);
  return (
    <header
      className={cn(
        "mb-3 flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl px-3.5 py-1.5",
        GLASS,
      )}
    >
      <h1 className="text-lg leading-5 font-semibold text-fg">Captain</h1>
      <div title={unavailable} className="flex items-center gap-2 text-base font-medium text-fg-soft">
        Auto-pilot
        {toggle}
      </div>
      <div className="tnum flex items-baseline gap-4 text-sm text-fg-muted">
        {total && (
          <span
            title="Auto-pilot spend today against its daily budget"
            className={cn(capTone(total) === "red" && "text-red")}
          >
            <b className="font-mono font-medium text-fg">{dollars(total.used.cost)}</b>
            {cap !== undefined && ` of ${dollars(cap)}`} today
          </span>
        )}
        {month && (month.spentUsd > 0 || month.ceilingUsd !== undefined) && (
          <span title="Everything majhi spent this month" className={cn(month.held && "text-red")}>
            <b className="font-mono font-medium text-fg">{dollars(month.spentUsd)}</b> this month
          </span>
        )}
      </div>
      {chip && (
        <button
          type="button"
          onClick={onSummary}
          className={cn(
            "flex h-6 min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-full border bg-raised px-2.5 text-sm hover:border-line-hover",
            chip.over ? "border-amber-line text-amber-soft" : "border-line-control text-fg-soft",
          )}
        >
          <Lamp state="needs" size={6} />
          <span className="min-w-0 truncate">{chip.text}</span>
        </button>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button variant="secondary" size="sm" disabled={captain === undefined} onClick={onPermissions}>
          <ShieldCheck aria-hidden="true" />
          Permissions
        </Button>
        <Button variant="secondary" size="sm" onClick={onResults}>
          <BarChart3 aria-hidden="true" />
          Results
        </Button>
        <Button variant="secondary" size="sm" disabled={captain === undefined} onClick={onHistory}>
          <History aria-hidden="true" />
          History
        </Button>
      </div>
      {dialogs}
    </header>
  );
}
