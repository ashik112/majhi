import type { AutonomyStatus } from "@majhi/shared";
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { Problem } from "@/components/problem";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { autonomyMissing, useAutonomyStatus } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import { ModeControls } from "./controls";
import { WorkPane } from "./desk";
import { LogPane } from "./feed";
import { ChatPane } from "./guide";
import {
  capText,
  capTone,
  clockTime,
  MODE_LAMP,
  MODE_WORD,
  markSummarySeen,
  modeLine,
  seenSummary,
} from "./model";
import { RulesView } from "./rules";
import { SummaryCard } from "./sections";

type View = "desk" | "log" | "rules" | "summary";

/** The mode, since when, and why, under the title. */
function ModeLine({ status, now }: { status: AutonomyStatus; now: number }) {
  const lamp = MODE_LAMP[status.mode];
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Lamp state={lamp} size={7} />
      <span className={cn("shrink-0", LAMP_TEXT[lamp])}>{MODE_WORD[status.mode]}</span>
      {status.since && status.mode !== "off" && (
        <span className="tnum shrink-0 text-fg-muted">since {clockTime(status.since, now)}</span>
      )}
      <span className="min-w-0 truncate text-fg-faint" title={status.why ?? modeLine(status.mode)}>
        {status.why ?? modeLine(status.mode)}
      </span>
    </span>
  );
}

const SPEND_TEXT = { calm: "text-fg", amber: "text-amber", red: "text-red" } as const;

/** Today's spend against the day cap, as a telemetry readout. */
function SpendReadout({ status }: { status: AutonomyStatus }) {
  const total = status.spend.total;
  const tone = capTone(total);
  const cost = total.cap?.cost;
  return (
    <span title={`Spent today: ${capText(total)}`} className="flex shrink-0 items-baseline gap-1.5">
      <span className={cn("tnum font-mono text-md font-medium", SPEND_TEXT[tone])}>
        {formatMoney(total.used.cost)}
      </span>
      <span className="text-sm text-fg-muted">
        {cost === undefined ? "today" : `of ${formatMoney(cost)} today`}
      </span>
    </span>
  );
}

/**
 * The Autonomous page, one flow on one screen: a status bar with the mode, today's spend and the
 * controls; then what needs the owner, what runs and what comes next with why, beside a compact log;
 * and the boss chat on the right. The rules and the daily summary are views of the same page.
 * Nothing scrolls but the lists, each inside its own panel.
 */
export function AutonomyView() {
  const query = useAutonomyStatus();
  const status = query.data;
  const now = useNow(30_000);
  const wide = useMedia("(min-width: 1280px)");
  const [picked, setView] = useState<View>("desk");
  // The log sits beside Now and next when there is room; otherwise it is a view of its own.
  const view: View = wide && picked === "log" ? "desk" : picked;
  const summaryDay = status?.summary?.day;
  // The strip points at a new summary until the owner opens it here.
  const [seen, setSeen] = useState(seenSummary);
  useEffect(() => {
    if (view !== "summary" || summaryDay === undefined) return;
    markSummarySeen(summaryDay);
    setSeen(summaryDay);
  }, [view, summaryDay]);
  const fresh = summaryDay !== undefined && seen !== summaryDay;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Autonomous"
        subtitle={
          status ? (
            <ModeLine status={status} now={now} />
          ) : (
            "The boss runs the desk while you are away, within your caps and rules."
          )
        }
      >
        {status && (
          <>
            <SpendReadout status={status} />
            <Segmented
              label="View"
              value={view}
              segments={[
                { value: "desk", label: wide ? "Desk" : "Now" },
                ...(wide ? [] : [{ value: "log" as const, label: "Log" }]),
                { value: "rules", label: "Rules" },
                { value: "summary", label: fresh ? "New summary" : "Summary" },
              ]}
              onChange={setView}
            />
            <ModeControls status={status} />
          </>
        )}
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
        <div className="flex min-h-0 min-w-0 flex-1 gap-3">
          <div className="flex min-h-0 min-w-0 flex-1 gap-3">
            {view === "desk" && (
              <>
                <WorkPane status={status} now={now} onRules={() => setView("rules")} />
                {wide && <LogPane now={now} />}
              </>
            )}
            {view === "log" && <LogPane now={now} />}
            {view === "rules" && <RulesView status={status} now={now} />}
            {view === "summary" && (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-6 scroll-fade">
                {status.summary ? (
                  <SummaryCard summary={status.summary} now={now} />
                ) : (
                  <p className="m-auto max-w-[360px] text-center text-base text-fg-muted text-pretty">
                    No daily summary yet. One is made at {status.settings.summary_at} after a day autonomous
                    mode ran.
                  </p>
                )}
              </div>
            )}
          </div>
          <ChatPane status={status} className="w-[320px] min-[1320px]:w-[360px]" />
        </div>
      )}
    </div>
  );
}
