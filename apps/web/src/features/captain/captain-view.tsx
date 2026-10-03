import { type CaptainStatus, PRIVATE } from "@majhi/shared";
import { Ship } from "lucide-react";
import { useState } from "react";
import { Problem } from "@/components/problem";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { AutonomousSwitch } from "@/features/autonomy/switch";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { useCaptainAsks, useCaptainStatus } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import { badgeLetters } from "@/lib/format";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import { CaptainLog } from "./log";
import { WorkspaceCard } from "./workspace-card";

const SUBTITLE =
  'How much the captain does, per workspace. It acts on its own only while Autonomous is on, and never in a workspace set to "Only when I ask".';

/**
 * The Captain page: one card per workspace with how much the captain does there, its budget and
 * "More rules", the day's line, and the captain's log beside it (a view of its own below 1280 px).
 * The stop switch sits in the header. Only the lists scroll, each inside its own panel.
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
  const [picked, setView] = useState<"workspaces" | "log">("workspaces");
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
              { value: "log", label: "Log" },
            ]}
            onChange={setView}
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
          {(wide || view === "log") && (
            <CaptainLog
              status={status}
              now={now}
              className={wide ? "w-[360px] shrink-0 min-[1440px]:w-[400px]" : "flex-1"}
            />
          )}
        </div>
      )}
    </div>
  );
}
