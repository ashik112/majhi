import { type CaptainStatus, PRIVATE } from "@majhi/shared";
import { useSearch } from "@tanstack/react-router";
import { Ship } from "lucide-react";
import { useEffect, useState } from "react";
import { Problem } from "@/components/problem";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { AutonomousSwitch } from "@/features/autonomy/switch";
import { useBoss } from "@/features/boss/boss-context";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { useCaptainAsks, useCaptainStatus } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { badgeLetters } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import { CaptainLog } from "./log";
import { CaptainPanel } from "./panel";
import { wsTab } from "./panel-model";
import { WorkspaceCard } from "./workspace-card";

const SUBTITLE =
  "How much the captain does in each workspace. It acts on its own only while Autonomous is on.";

/**
 * The Captain page: one card per workspace with how much the captain does there, its budget and
 * "More rules" and the day's line, and beside them the Captain panel (its threads) or the captain's
 * log. Below 1280 px each is a view of its own. The Autonomous switch sits in the header. Only the
 * lists scroll, each inside its own panel.
 */
export function CaptainView() {
  const query = useCaptainStatus();
  const status = query.data;
  const autonomy = useAutonomyStatus().data;
  const asks = useCaptainAsks().data?.asks ?? [];
  const orgs = useOrgs().data ?? [];
  const accounts = useAccounts().data ?? [];
  const now = useNow(30_000);
  const wide = useMedia("(min-width: 1280px)");
  const { thread } = useSearch({ strict: false }) as { thread?: string };
  const { setTab } = useBoss();
  const [picked, setView] = useState<"workspaces" | "threads" | "log">(
    thread === undefined ? "workspaces" : "threads",
  );
  // Wide, the workspaces stay on the left and this picks what sits beside them.
  const [side, setSide] = useState<"threads" | "log">("threads");
  // A link to a thread (an old address of a lane chat) opens its tab.
  useEffect(() => {
    if (thread === undefined) return;
    setTab(wsTab(thread));
    setView("threads");
    setSide("threads");
  }, [thread, setTab]);
  const view = wide ? "workspaces" : picked;
  const zone = autonomy?.settings.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Captain" subtitle={SUBTITLE}>
        {status && !wide && (
          <Segmented
            label="View"
            value={view}
            segments={[
              { value: "workspaces", label: "Workspaces" },
              { value: "threads", label: "Threads" },
              { value: "log", label: "Log" },
            ]}
            onChange={setView}
          />
        )}
        {status && wide && (
          <Segmented
            label="Beside the workspaces"
            value={side}
            segments={[
              { value: "threads", label: "Threads" },
              { value: "log", label: "Log" },
            ]}
            onChange={setSide}
          />
        )}
        <AutonomousSwitch />
      </PageHeader>
      {query.isError ? (
        <Problem icon={<Ship />} title="Could not load the captain" body={describeError(query.error)} />
      ) : !status ? (
        <RowsSkeleton rows={3} height={180} />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 gap-3">
          {view === "workspaces" && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pb-6 scroll-fade">
              {status.captain === undefined && (
                <p className="rounded-xl border border-amber-line bg-amber-wash px-4 py-2.5 text-sm text-amber text-pretty">
                  There is no captain yet. Choose one on the Agents page; until then nothing here runs.
                </p>
              )}
              {status.orgs.map((org) => {
                const view = orgs.find((o) => o.id === org.org);
                return (
                  <WorkspaceCard
                    key={org.org}
                    org={org}
                    badge={
                      view === undefined
                        ? org.org === PRIVATE
                          ? "PR"
                          : badgeLetters(org.name)
                        : badgeLetters(view.key)
                    }
                    color={view?.color}
                    accounts={accounts}
                    autonomyOn={status.autonomy === "on"}
                    dayCap={autonomy?.settings.day.cost}
                    zone={zone}
                    asks={asks.filter((a) => a.org === org.org)}
                  />
                );
              })}
            </div>
          )}
          {(wide ? side === "threads" : view === "threads") && (
            <section
              aria-label="Captain threads"
              className={cn(
                "flex min-h-0 flex-col rounded-2xl p-4",
                GLASS,
                wide ? "w-[380px] shrink-0 min-[1440px]:w-[420px]" : "min-w-0 flex-1",
              )}
            >
              <CaptainPanel />
            </section>
          )}
          {(wide ? side === "log" : view === "log") && (
            <CaptainLog
              status={status}
              now={now}
              className={wide ? "w-[380px] shrink-0 min-[1440px]:w-[420px]" : "flex-1"}
            />
          )}
        </div>
      )}
    </div>
  );
}
