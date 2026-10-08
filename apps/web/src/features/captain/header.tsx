import type { AutonomyStatus, CaptainStatus } from "@majhi/shared";
import { BarChart3, History, ShieldCheck } from "lucide-react";
import { Lamp } from "@/components/ui/lamp";
import { Menu } from "@/components/ui/menu";
import { Segmented } from "@/components/ui/segmented";
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
 * The top of the Captain page, one slim bar: Dashboard | Chat, the Auto-pilot switch with Stop everything, and one
 * menu holding the spend, Permissions, Results and History.
 */
export function CaptainHeader({
  captain,
  autonomy,
  now,
  onPermissions,
  onSummary,
  onResults,
  onHistory,
  view,
  onView,
}: {
  /** Undefined while `captain.status` loads: the header draws at once and fills in. */
  captain: CaptainStatus | undefined;
  autonomy: AutonomyStatus | undefined;
  now: number;
  onPermissions: () => void;
  onSummary: () => void;
  onResults: () => void;
  onHistory: () => void;
  view: "dashboard" | "captain";
  onView: (view: "dashboard" | "captain") => void;
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
      <Segmented
        label="Captain view"
        value={view}
        onChange={onView}
        segments={[
          { value: "dashboard", label: "Dashboard" },
          { value: "captain", label: "Chat" },
        ]}
      />
      <div title={unavailable} className="flex items-center gap-2 text-base font-medium text-fg-soft">
        Auto-pilot
        {toggle}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Menu
          label="More"
          items={[
            ...(total
              ? [
                  {
                    group: "Spend",
                    label: `${dollars(total.used.cost)}${cap === undefined ? "" : ` of ${dollars(cap)}`} today`,
                    onSelect: () => undefined,
                    disabled: true,
                  },
                ]
              : []),
            ...(month && (month.spentUsd > 0 || month.ceilingUsd !== undefined)
              ? [
                  {
                    group: "Spend",
                    label: `${dollars(month.spentUsd)} this month`,
                    onSelect: () => undefined,
                    disabled: true,
                  },
                ]
              : []),
            {
              group: "Captain",
              label: "Permissions",
              icon: <ShieldCheck aria-hidden="true" />,
              onSelect: onPermissions,
              disabled: captain === undefined,
            },
            {
              group: "Captain",
              label: "Results",
              icon: <BarChart3 aria-hidden="true" />,
              onSelect: onResults,
            },
            {
              group: "Captain",
              label: "History",
              icon: <History aria-hidden="true" />,
              onSelect: onHistory,
              disabled: captain === undefined,
            },
            ...(chip === undefined
              ? []
              : [
                  {
                    group: "Captain",
                    label: chip.text,
                    icon: <Lamp state="needs" size={6} />,
                    onSelect: onSummary,
                  },
                ]),
          ]}
        />
      </div>
      {dialogs}
    </header>
  );
}
