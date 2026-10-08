import { PAGE_PATH } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Ship } from "lucide-react";
import { useEffect, useState } from "react";
import { Problem } from "@/components/problem";
import { Sheet } from "@/components/ui/sheet";
import { markSeen } from "@/features/autonomy/summary-seen";
import { useBoss } from "@/features/boss/boss-context";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { useCaptainStatus } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { useNow } from "@/lib/use-now";
import type { AppSearch } from "@/router";
import { Conversation } from "./conversation";
import { AutopilotDashboard } from "./dashboard/dashboard";
import { DelegationSheet } from "./delegation";
import { FindingsSheet } from "./findings";
import { CaptainHeader } from "./header";
import { FullLog } from "./log";
import { NowColumn } from "./now-column";
import { wsTab } from "./panel-model";
import { ScorecardSheet } from "./scorecard";
import { dayLabel, SummaryTime, SummaryView } from "./summary";

type View = "dashboard" | "captain";

type Open = "delegation" | "log" | "summary" | "findings" | "scorecard";

/** The sheet an old `?tab=` link asked for: Rules is the delegation grid, Log is the log. */
function sheetOf(tab: string | undefined): Open | undefined {
  if (tab === "rules") return "delegation";
  if (tab === "log") return "log";
  if (tab === "findings") return "findings";
  return undefined;
}

/**
 * The Captain page, one screen and no tabs: the slim header with the Auto-pilot switch and spend, the conversation on the left, and what needs you, what runs, what is next and what the
 * captain did on the right. Delegation, the full log and yesterday's summary open in sheets. Old
 * links with `?tab=` land here and open the sheet they meant.
 */
export function CaptainView() {
  const query = useCaptainStatus();
  const status = query.data;
  const autonomy = useAutonomyStatus(true).data;
  const now = useNow(30_000);
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const { setTab } = useBoss();
  const [open, setOpen] = useState<Open | undefined>(() => sheetOf(search.tab));
  const thread = search.thread;
  const tab = search.tab;
  // The dashboard is the top view while Auto-pilot is on, and a tab when it is off. Old links to a
  // thread or to a sheet's tab open the conversation.
  const [picked, setPicked] = useState<View | undefined>(() =>
    tab === "dashboard" ? "dashboard" : undefined,
  );
  const forced = thread !== undefined || (tab !== undefined && tab !== "dashboard");
  const view: View = forced ? "captain" : (picked ?? (autonomy?.mode === "on" ? "dashboard" : "captain"));
  // A link to a thread (an old address of a lane chat) selects it in the conversation.
  useEffect(() => {
    if (thread !== undefined) setTab(wsTab(thread));
  }, [thread, setTab]);
  // A link to an old tab opens its sheet, and the chat tab selects the conversation.
  useEffect(() => {
    const asked = sheetOf(tab);
    if (asked !== undefined) setOpen(asked);
  }, [tab]);

  const close = () => {
    setOpen(undefined);
    if (tab !== undefined || thread !== undefined)
      void navigate({
        to: PAGE_PATH.captain,
        search: (prev: AppSearch) => {
          const { tab: _tab, thread: _thread, urgent: _urgent, ...rest } = prev;
          return rest;
        },
        replace: true,
      } as never);
  };
  const summary = autonomy?.summary;
  const openSummary = () => {
    if (summary === undefined) return;
    markSeen(summary.day);
    setOpen("summary");
  };

  if (query.isError)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Problem icon={<Ship />} title="Could not load the captain" body={describeError(query.error)} />
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CaptainHeader
        captain={status}
        autonomy={autonomy}
        now={now}
        onPermissions={() => setOpen("delegation")}
        onSummary={openSummary}
        onResults={() => setOpen("scorecard")}
        onHistory={() => setOpen("log")}
        view={view}
        onView={(v) => {
          setPicked(v);
          if (tab !== undefined || thread !== undefined) close();
        }}
      />
      {view === "dashboard" ? (
        <AutopilotDashboard autonomy={autonomy} now={now} />
      ) : (
        <div className="grid min-h-0 min-w-0 flex-1 gap-3 max-[999px]:overflow-y-auto min-[1000px]:grid-cols-[minmax(0,1fr)_minmax(340px,420px)] min-[1000px]:grid-rows-[minmax(0,1fr)]">
          <section
            aria-label="Conversation"
            className={`flex min-h-0 min-w-0 flex-col rounded-2xl max-[999px]:min-h-[520px] ${GLASS}`}
          >
            <Conversation page />
          </section>
          <NowColumn
            captain={status}
            autonomy={autonomy}
            now={now}
            onLog={() => setOpen("log")}
            onFindings={() => setOpen("findings")}
            onSummary={summary === undefined ? undefined : openSummary}
          />
        </div>
      )}
      {open === "delegation" && status && <DelegationSheet captain={status} now={now} onClose={close} />}
      {open === "log" && status && (
        <Sheet title="History" subtitle="What the captain did, and why" onClose={close}>
          <FullLog orgs={status.orgs} now={now} />
        </Sheet>
      )}
      {open === "scorecard" && (
        <Sheet title="Results" subtitle="What the captain did and how it turned out" onClose={close} wide>
          <ScorecardSheet />
        </Sheet>
      )}
      {open === "findings" && status && (
        <Sheet title="Findings" subtitle="What the captain and your agents noticed" onClose={close} wide>
          <FindingsSheet orgs={status.orgs} now={now} focus={Number(search.id) || undefined} />
        </Sheet>
      )}
      {open === "summary" && summary && (
        <Sheet
          title="Daily summary"
          subtitle={dayLabel(summary.day)}
          onClose={close}
          footer={autonomy && <SummaryTime settings={autonomy.settings} />}
        >
          <SummaryView summary={summary} />
        </Sheet>
      )}
    </div>
  );
}
