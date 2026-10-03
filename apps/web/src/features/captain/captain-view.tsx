import { useNavigate, useSearch } from "@tanstack/react-router";
import { Ship } from "lucide-react";
import { useEffect } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageLink } from "@/components/ui/page-link";
import { Segmented } from "@/components/ui/segmented";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useBoss } from "@/features/boss/boss-context";
import { useCaptainStatus } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { PAGE_PATH } from "@/lib/pages";
import { useNow } from "@/lib/use-now";
import type { AppSearch } from "@/router";
import { CaptainLog } from "./log";
import { CaptainPanel } from "./panel";
import { wsTab } from "./panel-model";
import { RulesTab } from "./rules-tab";
import { TodayTab } from "./today";

const SUBTITLE =
  "Your chief of staff. It works in each workspace within the rules you set, while Autonomous is on.";

const TABS = ["today", "chat", "log", "rules"] as const;
export type CaptainTab = (typeof TABS)[number];

/** The tab an address asks for: `?tab=`, else Chat for an old link to a thread, else Today. */
export function captainTab(search: Pick<AppSearch, "tab" | "thread">): CaptainTab {
  const asked = TABS.find((t) => t === search.tab);
  if (asked !== undefined) return asked;
  return search.thread === undefined ? "today" : "chat";
}

/**
 * The Captain page, one place for the chief of staff: Today (summary, what runs, what is next,
 * spend), Chat (talk to it, one thread per workspace), Log (what it did and why, with Undo) and
 * Rules (who decides what per workspace). The tab is in the address. The Autonomous switch is in
 * the sidebar under Captain. Only the lists scroll, each inside its own panel.
 */
export function CaptainView() {
  const query = useCaptainStatus();
  const status = query.data;
  const now = useNow(30_000);
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const { setTab } = useBoss();
  const tab = captainTab(search);
  const thread = search.thread;
  // A link to a thread (an old address of a lane chat) opens its tab in the panel.
  useEffect(() => {
    if (thread !== undefined) setTab(wsTab(thread));
  }, [thread, setTab]);
  const pick = (next: CaptainTab) =>
    void navigate({
      to: PAGE_PATH.captain,
      search: (prev: AppSearch) => {
        const { thread: _thread, ...rest } = prev;
        return { ...rest, tab: next };
      },
      replace: true,
    } as never);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Captain" subtitle={SUBTITLE}>
        <Button asChild size="lg" variant="secondary">
          <PageLink page="limits">Limits</PageLink>
        </Button>
      </PageHeader>
      {query.isError ? (
        <Problem icon={<Ship />} title="Could not load the captain" body={describeError(query.error)} />
      ) : !status ? (
        <RowsSkeleton rows={3} height={180} />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <Segmented
            label="Captain"
            value={tab}
            segments={[
              { value: "today", label: "Today" },
              { value: "chat", label: "Chat" },
              { value: "log", label: "Log" },
              { value: "rules", label: "Rules" },
            ]}
            onChange={pick}
            className="self-start"
          />
          {tab === "today" && <TodayTab captain={status} now={now} onRules={() => pick("rules")} />}
          {tab === "chat" && (
            <section
              aria-label="Captain chat"
              className={`flex min-h-0 min-w-0 max-w-[980px] flex-1 flex-col rounded-2xl p-4 ${GLASS}`}
            >
              <CaptainPanel />
            </section>
          )}
          {tab === "log" && (
            <div className="flex min-h-0 min-w-0 max-w-[980px] flex-1 flex-col">
              <CaptainLog status={status} now={now} />
            </div>
          )}
          {tab === "rules" && <RulesTab captain={status} now={now} />}
        </div>
      )}
    </div>
  );
}
