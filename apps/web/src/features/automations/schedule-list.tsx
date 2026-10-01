import type { OrgView, ScheduleView } from "@majhi/shared";
import { Clock, Plus } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OrgBadge } from "@/components/ui/org-badge";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { orgLabel } from "@/features/accounts/model";
import { useAutomationCommand } from "@/lib/automation-queries";
import { describeError } from "@/lib/errors";
import { badgeLetters } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import {
  describeAction,
  describeSpec,
  formatIn,
  formatInZone,
  RUN_STATUS,
  specCode,
  yourTime,
} from "./model";
import { GridRow, LastRun, RowActions, RowsPanel, StateBadge } from "./parts";

const COLUMNS = "minmax(0,1.5fr) minmax(0,1.2fr) minmax(0,1.1fr) minmax(0,1.5fr) 232px";

export function ScheduleList({
  schedules,
  orgs,
  onEdit,
  onHistory,
  onCreate,
}: {
  schedules: readonly ScheduleView[] | undefined;
  orgs: readonly OrgView[];
  onEdit: (schedule: ScheduleView) => void;
  onHistory: (schedule: ScheduleView) => void;
  onCreate: () => void;
}) {
  const now = useNow(30_000);
  const toast = useToast();
  const run = useAutomationCommand("schedules.runNow");
  const pause = useAutomationCommand("schedules.pause");
  const resume = useAutomationCommand("schedules.resume");
  const remove = useAutomationCommand("schedules.delete");
  const [deleting, setDeleting] = useState<ScheduleView>();
  const [problem, setProblem] = useState<string>();

  if (schedules === undefined) return <RowsSkeleton rows={4} />;
  if (schedules.length === 0) return <EmptyState what="schedule" onCreate={onCreate} />;

  const busy = run.isPending || pause.isPending || resume.isPending;
  const fail = (e: unknown) => toast("Could not do that", { detail: describeError(e), tone: "error" });

  return (
    <>
      <RowsPanel label="Schedules" columns={COLUMNS} heads={["Schedule", "When", "Next run", "Last run", ""]}>
        {schedules.map((s) => {
          const org = orgLabel(s.org, orgs);
          const key = orgs.find((o) => o.id === s.org)?.key ?? s.org;
          const code = specCode(s.spec);
          const local = s.nextRunAt === null ? undefined : yourTime(s.nextRunAt, s.timeZone);
          return (
            <GridRow key={s.id} columns={COLUMNS}>
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onHistory(s)}
                    className="min-w-0 cursor-pointer truncate text-left text-base font-medium text-fg hover:underline"
                  >
                    {s.name}
                  </button>
                  <StateBadge paused={s.paused} done={s.done} />
                  {s.overlap === "allow" && <Badge title="Runs may overlap">Overlap allowed</Badge>}
                </div>
                <p className="line-clamp-2 text-sm text-fg-muted text-pretty">{describeAction(s.action)}</p>
                <p className="flex items-center gap-1.5 text-xs text-fg-faint">
                  <OrgBadge label={badgeLetters(key)} color={org.color} size="xs" />
                  {org.name}
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-base text-fg">{describeSpec(s.spec)}</span>
                {code !== undefined && (
                  <span className="truncate font-mono text-xs text-fg-muted">{code}</span>
                )}
                <span className="flex items-center gap-1.5 text-xs text-fg-faint">
                  <Clock aria-hidden="true" className="size-3" />
                  <span className="font-mono">{s.timeZone}</span>
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                {s.nextRunAt === null ? (
                  <span className="text-sm text-fg-faint">{s.done ? "Ran once" : "Paused"}</span>
                ) : (
                  <>
                    <span className="tnum text-base text-fg">{formatInZone(s.nextRunAt, s.timeZone)}</span>
                    <span className="tnum text-sm text-fg-muted">{formatIn(s.nextRunAt, now)}</span>
                    {local !== undefined && (
                      <span className="tnum text-xs text-fg-faint">Your time: {local}</span>
                    )}
                  </>
                )}
              </div>
              <LastRun run={s.lastRun} now={now} />
              <RowActions
                name={s.name}
                paused={s.paused}
                done={s.done}
                busy={busy}
                onRun={() =>
                  run.mutate(
                    { id: s.id },
                    {
                      onSuccess: (r) =>
                        toast(`Run now: ${RUN_STATUS[r.status].label.toLowerCase()}`, {
                          detail: r.detail,
                          tone: r.status === "failed" ? "error" : "success",
                        }),
                      onError: fail,
                    },
                  )
                }
                onToggle={() => (s.paused ? resume : pause).mutate({ id: s.id }, { onError: fail })}
                onHistory={() => onHistory(s)}
                onEdit={() => onEdit(s)}
                onDelete={() => {
                  setProblem(undefined);
                  setDeleting(s);
                }}
              />
            </GridRow>
          );
        })}
      </RowsPanel>
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          body="The schedule and its run history are removed. Tasks and processes it started are not touched."
          confirmLabel="Delete"
          busy={remove.isPending}
          error={problem}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() =>
            remove.mutate(
              { id: deleting.id },
              {
                onSuccess: () => setDeleting(undefined),
                onError: (e) => setProblem(describeError(e)),
              },
            )
          }
        />
      )}
    </>
  );
}

/** What the page shows before the first schedule or trigger. */
export function EmptyState({ what, onCreate }: { what: "schedule" | "trigger"; onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-3 px-8">
      <h2 className="text-md font-semibold">
        {what === "schedule" ? "No schedules yet" : "No triggers yet"}
      </h2>
      <p className="max-w-[56ch] text-base text-fg-muted text-pretty">
        {what === "schedule"
          ? "A schedule starts a task, posts to a task's room or runs a command every few minutes, on a cron expression, or once."
          : "A trigger watches a task, a branch, a file, a process, your usage, a URL or a command, and runs an action when it changes."}
      </p>
      <Button variant="primary" onClick={onCreate}>
        <Plus aria-hidden="true" />
        New {what}
      </Button>
    </div>
  );
}
