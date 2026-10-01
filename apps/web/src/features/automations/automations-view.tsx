import type { ScheduleView, TriggerView } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { useSchedules, useTriggers } from "@/lib/automation-queries";
import { describeError } from "@/lib/errors";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import type { AppSearch } from "@/router";
import { HistoryDrawer } from "./history-drawer";
import { BROWSER_ZONE } from "./model";
import { ScheduleForm } from "./schedule-form";
import { ScheduleList } from "./schedule-list";
import { TriggerForm } from "./trigger-form";
import { TriggerList } from "./trigger-list";

type Tab = "schedules" | "triggers";

type Open =
  | { kind: "schedule-form"; schedule?: ScheduleView }
  | { kind: "trigger-form"; trigger?: TriggerView }
  | { kind: "history"; of: "schedule" | "trigger"; id: string; name: string; zone: string };

/**
 * Automations: schedules that run on a clock, and triggers that watch something. Both start a
 * task, post to a room or run a command, and both keep a history of every run. The sidebar's org
 * filter picks which org's rows show; `?tab=` keeps the tab.
 */
export function AutomationsView() {
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const tab: Tab = search.tab === "triggers" ? "triggers" : "schedules";
  const { org } = useOrgFilter();
  const orgs = useOrgs();
  const schedules = useSchedules(org);
  const triggers = useTriggers(org);
  const [open, setOpen] = useState<Open>();
  const close = () => setOpen(undefined);

  const failed = (tab === "schedules" ? schedules.error : triggers.error) ?? orgs.error;
  const orgList = orgs.data ?? [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Automations"
        subtitle="Jobs that run on a clock, and watches that fire when something changes. Times show the schedule's own zone."
      >
        <Segmented
          label="Automations"
          value={tab}
          segments={[
            { value: "schedules", label: "Schedules", count: schedules.data?.length ?? 0 },
            { value: "triggers", label: "Triggers", count: triggers.data?.length ?? 0 },
          ]}
          onChange={(next) =>
            void navigate({
              to: ".",
              search: (prev: AppSearch): AppSearch => ({ ...prev, tab: next }),
              replace: true,
            })
          }
        />
        <Button
          variant="primary"
          onClick={() => setOpen(tab === "schedules" ? { kind: "schedule-form" } : { kind: "trigger-form" })}
        >
          <Plus aria-hidden="true" />
          {tab === "schedules" ? "New schedule" : "New trigger"}
        </Button>
      </PageHeader>
      {failed ? (
        <p role="alert" className="p-8 text-base text-red">
          Could not load automations: {describeError(failed)}
        </p>
      ) : tab === "schedules" ? (
        <ScheduleList
          schedules={schedules.data}
          orgs={orgList}
          onCreate={() => setOpen({ kind: "schedule-form" })}
          onEdit={(schedule) => setOpen({ kind: "schedule-form", schedule })}
          onHistory={(s) =>
            setOpen({ kind: "history", of: "schedule", id: s.id, name: s.name, zone: s.timeZone })
          }
        />
      ) : (
        <TriggerList
          triggers={triggers.data}
          orgs={orgList}
          onCreate={() => setOpen({ kind: "trigger-form" })}
          onEdit={(trigger) => setOpen({ kind: "trigger-form", trigger })}
          onHistory={(t) =>
            setOpen({ kind: "history", of: "trigger", id: t.id, name: t.name, zone: BROWSER_ZONE })
          }
        />
      )}
      {open?.kind === "schedule-form" && (
        <ScheduleForm schedule={open.schedule} orgs={orgList} defaultOrg={org} onClose={close} />
      )}
      {open?.kind === "trigger-form" && (
        <TriggerForm trigger={open.trigger} orgs={orgList} defaultOrg={org} onClose={close} />
      )}
      {open?.kind === "history" && (
        <HistoryDrawer kind={open.of} id={open.id} name={open.name} zone={open.zone} onClose={close} />
      )}
    </div>
  );
}
