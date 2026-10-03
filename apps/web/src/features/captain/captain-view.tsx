import { type CaptainStatus, PRIVATE } from "@majhi/shared";
import { Ship } from "lucide-react";
import { useState } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Lamp } from "@/components/ui/lamp";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { clockTime } from "@/features/autonomy/model";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { useCaptainAsks, useCaptainCommand, useCaptainStatus } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import { badgeLetters } from "@/lib/format";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import { CaptainLog } from "./log";
import { WorkspaceCard } from "./workspace-card";

const SUBTITLE =
  'How much the captain does, per workspace. It never acts on its own in a workspace set to "Only when I ask".';

/** Stop the captain, or resume it: the one switch for every lane and run. */
function StopSwitch({ status }: { status: CaptainStatus }) {
  const toast = useToast();
  const stop = useCaptainCommand("captain.stop");
  const resume = useCaptainCommand("captain.resume");
  const [asking, setAsking] = useState(false);
  if (status.stopped) {
    return (
      <Button
        variant="primary"
        disabled={resume.isPending}
        onClick={() =>
          resume.mutate(
            { input: {}, reason: "Owner resumed the captain" },
            { onSuccess: () => toast("The captain acts again, by each workspace's choice") },
          )
        }
      >
        Resume the captain
      </Button>
    );
  }
  return (
    <>
      <Button
        variant="secondary"
        className="border-red-line text-red hover:border-red hover:bg-red-wash"
        onClick={() => setAsking(true)}
      >
        Stop the captain
      </Button>
      {asking && (
        <ConfirmDialog
          title="Stop the captain?"
          body="Every lane's turn and every upkeep run stop now, and autonomous mode turns off. Nothing of the captain acts on its own until you resume it. It still answers when you talk to it."
          confirmLabel="Stop the captain"
          busy={stop.isPending}
          error={stop.error ? describeError(stop.error) : undefined}
          onConfirm={() =>
            stop.mutate(
              { input: {}, reason: "Owner stopped the captain" },
              {
                onSuccess: () => {
                  setAsking(false);
                  toast("The captain is stopped");
                },
              },
            )
          }
          onCancel={() => {
            stop.reset();
            setAsking(false);
          }}
        />
      )}
    </>
  );
}

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
      <PageHeader
        title="Captain"
        subtitle={
          status?.stopped ? (
            <span className="flex min-w-0 items-center gap-2">
              <Lamp state="paused" size={7} />
              <span className="shrink-0 text-lamp-paused">Stopped</span>
              {status.stoppedAt && (
                <span className="tnum shrink-0 text-fg-muted">since {clockTime(status.stoppedAt, now)}</span>
              )}
              <span className="min-w-0 truncate text-fg-faint">
                Nothing acts on its own until you resume it.
              </span>
            </span>
          ) : (
            SUBTITLE
          )
        }
      >
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
        {status && <StopSwitch status={status} />}
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
                <p className="rounded-xl border border-caution-line bg-caution-wash px-4 py-2.5 text-sm text-amber text-pretty">
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
