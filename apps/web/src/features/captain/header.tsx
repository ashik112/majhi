import type { AutonomyStatus, CaptainOrg, CaptainStatus } from "@majhi/shared";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { Skeleton } from "@/components/ui/skeleton";
import { capTone, MODE_LAMP, MODE_WORD } from "@/features/autonomy/model";
import { useUnseenSummary } from "@/features/autonomy/summary-seen";
import { useAutonomousSwitch } from "@/features/autonomy/switch";
import { useNeedsYou } from "@/features/decisions/needs-you";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { statusSentence } from "./model";
import { summaryLine } from "./summary";

const SHOWN_SPEND = 3;

/** Whole dollars from $10 up, cents below. */
function dollars(n: number): string {
  return n >= 10 || Number.isInteger(n) ? `$${Math.round(n).toLocaleString("en-US")}` : formatMoney(n);
}

function over(org: CaptainOrg): boolean {
  return org.budget?.cost !== undefined && org.used.cost >= org.budget.cost;
}

/** Today's spend per workspace against its budget, then the total budget: "Private $31 · Acme $29 · of $200". */
function SpendLine({
  orgs,
  autonomy,
}: {
  orgs: readonly CaptainOrg[];
  autonomy: AutonomyStatus | undefined;
}) {
  const spending = orgs
    .filter((o) => o.used.cost > 0 || over(o))
    .toSorted((a, b) => b.used.cost - a.used.cost);
  const total = autonomy?.spend.total;
  const cap = total?.cap?.cost;
  const hidden = Math.max(0, spending.length - SHOWN_SPEND);
  if (spending.length === 0 && cap === undefined) return null;
  return (
    <p className="tnum flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-fg-muted">
      {cap !== undefined && total && (
        <span
          title="Autonomous spend today against its daily budget"
          className={cn("font-medium text-fg-soft", capTone(total) === "red" && "text-red")}
        >
          {formatMoney(total.used.cost)} of {dollars(cap)} today
        </span>
      )}
      {spending.slice(0, SHOWN_SPEND).map((org, i) => {
        const budget = org.budget?.cost;
        const bad = over(org);
        return (
          <span key={org.org} className="flex min-w-0 items-baseline gap-2">
            {(i > 0 || cap !== undefined) && <span aria-hidden="true">·</span>}
            <span
              className={cn("flex min-w-0 items-baseline gap-1.5", bad && "text-red")}
              title={`${org.name}: ${formatMoney(org.used.cost)} today${budget === undefined ? "" : ` of ${dollars(budget)}`}${bad ? ", over budget" : ""}`}
            >
              <span className="max-w-[140px] truncate">{org.name}</span>
              <span className="font-mono">
                {bad && budget !== undefined
                  ? `${formatMoney(org.used.cost)} of ${dollars(budget)}, over`
                  : dollars(org.used.cost)}
              </span>
            </span>
          </span>
        );
      })}
      {hidden > 0 && (
        <span>
          <span aria-hidden="true">· </span>+{hidden} more
        </span>
      )}
    </p>
  );
}

/**
 * The top of the Captain page: the Autonomous switch with its state, one sentence that is true now,
 * today's spend per workspace, and the ways to the delegation grid, the limits and yesterday's summary.
 */
export function CaptainHeader({
  captain,
  autonomy,
  now,
  onDelegation,
  onSummary,
}: {
  /** Undefined while `captain.status` loads: the header draws at once and fills in. */
  captain: CaptainStatus | undefined;
  autonomy: AutonomyStatus | undefined;
  now: number;
  onDelegation: () => void;
  onSummary: () => void;
}) {
  const { mode, toggle, dialogs, unavailable } = useAutonomousSwitch();
  const decisions = useNeedsYou();
  const lamp = MODE_LAMP[mode];
  const unseen = useUnseenSummary(now);
  const chip = unseen === undefined ? undefined : summaryLine(unseen, now);
  const sentence =
    captain === undefined
      ? undefined
      : statusSentence({
          mode,
          upkeep: captain.orgs.some((o) => o.authority.upkeep === "decide"),
          running: autonomy?.now.length ?? 0,
          next: autonomy?.queue.length ?? 0,
          decisions: decisions ?? 0,
        });
  return (
    <header className={cn("mb-3 flex shrink-0 flex-col gap-2 rounded-2xl px-6 py-3", GLASS)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
        <h1 className="text-xl leading-[26px] font-semibold tracking-[-0.01em] text-fg">Captain</h1>
        <div title={unavailable} className="flex items-center gap-2.5">
          {toggle}
          <span className="flex items-center gap-1.5 text-base">
            <Lamp state={lamp} size={7} />
            <span className="text-fg">Autonomous</span>
            <span className={cn("font-medium", LAMP_TEXT[lamp])}>{MODE_WORD[mode]}</span>
          </span>
        </div>
        {sentence === undefined ? (
          <Skeleton className="h-5 min-w-[260px] flex-1 basis-[320px]" />
        ) : (
          <p className="min-w-[260px] flex-1 basis-[320px] text-base text-fg-soft text-pretty">{sentence}</p>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="secondary" disabled={captain === undefined} onClick={onDelegation}>
            <SlidersHorizontal aria-hidden="true" />
            Delegation
          </Button>
          <PageLink
            page="limits"
            className="px-1 text-sm text-fg-muted underline underline-offset-[3px] hover:text-fg"
          >
            Limits
          </PageLink>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-1.5 min-[1000px]:flex-nowrap">
        {chip && (
          <button
            type="button"
            onClick={onSummary}
            className={cn(
              "flex min-w-0 max-w-full shrink cursor-pointer items-center gap-2 rounded-full border bg-raised px-3 py-0.5 text-left text-sm hover:border-line-hover",
              chip.over ? "border-amber-line text-amber-soft" : "border-line-control text-fg-soft",
            )}
          >
            <span className="min-w-0 truncate">{chip.text}</span>
          </button>
        )}
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5">
          <SpendLine orgs={captain?.orgs ?? []} autonomy={autonomy} />
        </div>
      </div>
      {dialogs}
    </header>
  );
}
