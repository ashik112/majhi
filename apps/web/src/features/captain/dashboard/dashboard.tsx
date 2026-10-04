import type { AutonomyStatus } from "@majhi/shared";
import { useMemo } from "react";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useAutonomyReport, useSlots } from "@/lib/autonomy-queries";
import { useDecisions } from "@/lib/decision-queries";
import { useOrgs } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useLogEntries } from "../log";
import { type OrgInfo, workspaceRows } from "./model";
import { Feed, Stuck } from "./side";
import { StatusStrip } from "./strip";
import { Workspaces } from "./workspaces";

function useOrgInfo(): OrgInfo[] {
  const orgs = useOrgs().data;
  return useMemo(() => (orgs ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })), [orgs]);
}

/**
 * Auto-pilot on one screen: a status strip, a table with a line per workspace, and beside it what is
 * stuck and what the captain did last. Nothing scrolls but a long list inside its own panel.
 */
export function AutopilotDashboard({ autonomy, now }: { autonomy: AutonomyStatus | undefined; now: number }) {
  const tasks = useTasks().data;
  const decisions = useDecisions().data?.decisions;
  const orgs = useOrgInfo();
  const report = useAutonomyReport(14);
  const slots = useSlots();
  const log = useLogEntries("", "all", true);
  const rows = useMemo(
    () =>
      autonomy === undefined
        ? []
        : workspaceRows(tasks ?? [], autonomy, decisions ?? [], orgs, log.entries, now),
    [autonomy, tasks, decisions, orgs, log.entries, now],
  );

  if (autonomy === undefined)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <RowsSkeleton rows={3} height={72} />
      </div>
    );
  return (
    <section aria-label="Auto-pilot dashboard" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <StatusStrip autonomy={autonomy} report={report.data} slots={slots.data} nowMs={now} />
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)] grid-cols-[minmax(0,1fr)_minmax(260px,300px)] gap-3 min-[1280px]:grid-cols-[minmax(0,1fr)_minmax(300px,340px)]">
        <Workspaces rows={rows} nowMs={now} />
        <div className="flex max-h-full min-h-0 min-w-0 flex-col gap-3 self-start">
          <Stuck stuck={report.data?.stuck} error={report.error} nowMs={now} />
          <Feed nowMs={now} orgs={orgs} many={rows.length > 1} />
        </div>
      </div>
    </section>
  );
}
