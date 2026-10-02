import type { AutonomyStatus } from "@majhi/shared";
import { Bot } from "lucide-react";
import { useEffect } from "react";
import { Problem } from "@/components/problem";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { PageHeader } from "@/components/ui/page-header";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { autonomyMissing, useAutonomyStatus } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useNow } from "@/lib/use-now";
import { ModeControls } from "./controls";
import { FeedCard } from "./feed";
import { GuideCard, InstructionsCard } from "./guide";
import { LimitsCard } from "./limits";
import { clockTime, MODE_LAMP, MODE_WORD, markSummarySeen, modeLine } from "./model";
import { NowCard, QueueCard, SummaryCard, WaitingCard } from "./sections";
import { SpendCard } from "./spend";

/** The mode, since when and why, then what the mode means, on one line under the title. */
function ModeLine({ status, now }: { status: AutonomyStatus; now: number }) {
  const lamp = MODE_LAMP[status.mode];
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Lamp state={lamp} size={7} />
      <span className={cn("shrink-0", LAMP_TEXT[lamp])}>{MODE_WORD[status.mode]}</span>
      {status.since && (
        <span className="tnum shrink-0 text-fg-muted">
          since {clockTime(status.since, now)}
          {status.by === "majhi" && " by majhi"}
        </span>
      )}
      <span className="min-w-0 truncate text-fg-faint">{status.why ?? modeLine(status.mode)}</span>
    </span>
  );
}

/**
 * The Autonomous page: the mode and its controls, the daily summary, what runs now, the queue, the
 * cards left for the owner, the feed and decisions, the chat box and standing instructions, spend
 * against the caps, and the limits.
 */
export function AutonomyView() {
  const query = useAutonomyStatus();
  const status = query.data;
  const now = useNow(30_000);
  const summaryDay = status?.summary?.day;
  // Opening the page counts as reading the newest summary: the strip stops pointing at it.
  useEffect(() => {
    if (summaryDay !== undefined) markSummarySeen(summaryDay);
  }, [summaryDay]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Autonomous"
        subtitle={
          status ? (
            <ModeLine status={status} now={now} />
          ) : (
            "The boss runs the desk while you are away, within your caps and limits."
          )
        }
      >
        {status && <ModeControls status={status} />}
      </PageHeader>
      {query.isError ? (
        <Problem
          icon={<Bot />}
          title={
            autonomyMissing(query.error)
              ? "Autonomous mode is not ready yet"
              : "Could not load autonomous mode"
          }
          body={describeError(query.error)}
        />
      ) : !status ? (
        <RowsSkeleton rows={4} height={96} />
      ) : (
        <div className="flex flex-col gap-3">
          {status.summary && <SummaryCard summary={status.summary} now={now} />}
          <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
            <div className="flex min-w-0 flex-col gap-3">
              <NowCard status={status} now={now} />
              <QueueCard status={status} now={now} />
              <WaitingCard waiting={status.waiting} />
              <FeedCard now={now} />
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <GuideCard status={status} now={now} />
              <InstructionsCard status={status} now={now} />
              <SpendCard status={status} now={now} />
              <LimitsCard status={status} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
