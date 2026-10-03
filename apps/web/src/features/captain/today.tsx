import type { AutonomyStatus, CaptainOrg, CaptainStatus } from "@majhi/shared";
import { Bot } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Problem } from "@/components/problem";
import { Card } from "@/components/ui/card";
import { Lamp } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { NextSection, NowSection } from "@/features/autonomy/desk";
import { capTone, markSummarySeen, todayLine } from "@/features/autonomy/model";
import { SummaryCard } from "@/features/autonomy/sections";
import { needsOwner } from "@/features/board/model";
import { BudgetAskCard } from "@/features/limits/budget-ask";
import { autonomyMissing, useAutonomyStatus } from "@/lib/autonomy-queries";
import { useCaptainAsks } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { useDecisions } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { formatMoney, plural } from "@/lib/format";
import { useTasks } from "@/lib/task-queries";
import { CapAskRow } from "./asks";

const TONE = { calm: "text-fg", amber: "text-amber", red: "text-red" } as const;

/** "$4.20 of $10" for a workspace that has a budget of its own, else what it used. */
function orgSpend(org: CaptainOrg): { text: string; tone: keyof typeof TONE } {
  const cost = org.budget?.cost;
  if (cost === undefined) return { text: formatMoney(org.used.cost), tone: "calm" };
  const percent = (org.used.cost / cost) * 100;
  return {
    text: `${formatMoney(org.used.cost)} of ${Number.isInteger(cost) ? `$${cost}` : formatMoney(cost)}`,
    tone: capTone({ percent, reached: percent >= 100 }),
  };
}

/** What waits on the owner, in one line, with the way to it. The board's Needs you column holds the items. */
function NeedsYou({ count }: { count: number }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-1 text-base">
      <Lamp state={count > 0 ? "needs" : "idle"} size={7} />
      {count > 0 ? (
        <>
          <span className="font-medium text-fg">
            {plural(count, "thing")} {count === 1 ? "needs" : "need"} you
          </span>
          <PageLink page="decisions" className="text-sm text-blue hover:underline">
            Open Decisions
          </PageLink>
        </>
      ) : (
        <span className="text-fg-muted">Nothing needs you right now.</span>
      )}
    </p>
  );
}

/** Spend today per workspace against its budget, small, with the way to the Limits screen. */
function SpendToday({ captain, autonomy }: { captain: CaptainStatus; autonomy: AutonomyStatus }) {
  return (
    <Card aria-label="Spend today">
      <div className="flex min-h-7 items-center gap-2">
        <h2 className="text-base font-semibold text-fg">Spend today</h2>
        <PageLink page="limits" className="ml-auto text-sm text-blue hover:underline">
          Limits
        </PageLink>
      </div>
      <p className={cn("tnum text-sm", TONE[capTone(autonomy.spend.total)])}>
        Autonomous: {todayLine(autonomy.spend.total)}
      </p>
      <ul className="flex flex-col">
        {captain.orgs.map((org) => {
          const spend = orgSpend(org);
          return (
            <li
              key={org.org}
              className="flex min-w-0 gap-3 border-t border-line py-1 text-sm first:border-t-0"
            >
              <span className="min-w-0 flex-1 truncate text-fg-soft" title={org.name}>
                {org.name}
              </span>
              <span className={cn("tnum shrink-0 font-mono", TONE[spend.tone])}>{spend.text}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * The Today tab: the latest daily summary, what the owner is asked (budget and limit questions),
 * a line for what waits on them, then what runs now and what comes next with why, beside the day's
 * spend per workspace.
 */
export function TodayTab({
  captain,
  now,
  onRules,
}: {
  captain: CaptainStatus;
  now: number;
  onRules: () => void;
}) {
  const query = useAutonomyStatus();
  const autonomy = query.data;
  const asks = useCaptainAsks().data;
  const tasks = useTasks().data;
  const decisions = useDecisions().data;
  const names = useMemo(() => new Map(captain.orgs.map((o) => [o.org, o.name])), [captain.orgs]);
  const summaryDay = autonomy?.summary?.day;
  // The sidebar and the strip point at a new summary until the owner has seen it here.
  useEffect(() => {
    if (summaryDay !== undefined) markSummarySeen(summaryDay);
  }, [summaryDay]);

  if (query.isError)
    return (
      <Problem
        icon={<Bot />}
        title={
          autonomyMissing(query.error) ? "Autonomous is not ready yet" : "Could not load the captain's day"
        }
        body={describeError(query.error)}
      />
    );
  if (!autonomy) return <RowsSkeleton rows={4} height={96} />;

  const capAsks = asks?.asks ?? [];
  const budgetAsks = asks?.budgets ?? [];
  // The same count as the bell: everything in the Decisions inbox.
  const waiting =
    decisions?.decisions.length ??
    (tasks ?? []).filter(needsOwner).length + capAsks.length + budgetAsks.length;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pb-6 scroll-fade">
      {autonomy.summary && <SummaryCard summary={autonomy.summary} now={now} />}
      {(budgetAsks.length > 0 || capAsks.length > 0) && (
        <div className="flex flex-col gap-2">
          {budgetAsks.map((ask) => (
            <BudgetAskCard key={ask.scope} ask={ask} />
          ))}
          {capAsks.map((ask) => (
            <CapAskRow key={`${ask.org}:${ask.chore}`} ask={ask} name={names.get(ask.org) ?? ask.org} />
          ))}
        </div>
      )}
      <NeedsYou count={waiting} />
      <div className="grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_320px] min-[1440px]:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-3">
          <Card aria-label="Running now">
            <NowSection status={autonomy} now={now} />
          </Card>
          <Card aria-label="Next, and why">
            <NextSection status={autonomy} now={now} onRules={onRules} />
          </Card>
        </div>
        <SpendToday captain={captain} autonomy={autonomy} />
      </div>
    </div>
  );
}
