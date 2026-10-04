import type { AutomationRun } from "@majhi/shared";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { Modal } from "@/components/ui/modal";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { TaskRef } from "@/features/task-drawer/task-ref";
import { useScheduleRuns } from "@/lib/automation-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatInZone, RUN_STATUS, runSpan } from "./model";

/**
 * The runs of one clock playbook, newest first, in a drawer over the page: status, when it
 * started and ended, what happened, and a link to the task or process it made.
 */
export function HistoryDrawer({
  id,
  name,
  zone,
  onClose,
}: {
  /** A clock playbook's id. */
  id: string;
  name: string;
  /** The zone the times are shown in: a schedule's own. */
  zone: string;
  onClose: () => void;
}) {
  const runs = useScheduleRuns(id);
  return (
    <Modal
      label={`History of ${name}`}
      onClose={onClose}
      className="fixed top-3 right-3 bottom-3 left-auto m-0 h-[calc(100dvh-24px)] max-h-none w-[min(520px,100vw)] max-w-[calc(100vw-24px)] flex-col open:flex rounded-2xl"
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-line-strong px-5 py-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-md font-semibold">{name}</span>
          <span className="truncate text-xs text-fg-faint">
            Run history · times in <span className="font-mono">{zone}</span>
          </span>
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Close history" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-3 pb-6 scroll-fade">
        {runs.error ? (
          <p role="alert" className="text-base text-red">
            Could not load the history: {describeError(runs.error)}
          </p>
        ) : runs.data === undefined ? (
          <RowsSkeleton rows={4} height={64} />
        ) : runs.data.length === 0 ? (
          <p className="text-base text-fg-muted">
            No runs yet. Press Run now to try it, or wait for it to fire.
          </p>
        ) : (
          <ol className="flex flex-col">
            {runs.data.map((run) => (
              <RunItem key={run.id} run={run} zone={zone} />
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}

function RunItem({ run, zone }: { run: AutomationRun; zone: string }) {
  const status = RUN_STATUS[run.status];
  const span = runSpan(run);
  return (
    <li className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className={cn("flex items-center gap-1.5 text-base font-medium", LAMP_TEXT[status.lamp])}>
          <Lamp state={status.lamp} size={7} />
          {status.label}
        </span>
        <span className="tnum text-sm text-fg-soft">{formatInZone(run.startedAt, zone)}</span>
        {run.endedAt !== null && span !== undefined && (
          <span className="tnum text-sm text-fg-faint">
            ended {formatInZone(run.endedAt, zone)} · {span}
          </span>
        )}
        <span className="tnum ml-auto font-mono text-xs text-fg-faint">#{run.id}</span>
      </div>
      <p className="text-sm text-fg-muted text-pretty">{run.detail}</p>
      {run.taskId !== null && (
        <p className="text-sm text-fg-faint">
          {run.processId === null ? (
            "Task "
          ) : (
            <>
              Process <span className="font-mono">{run.processId}</span> in{" "}
            </>
          )}
          <TaskRef id={run.taskId} />
        </p>
      )}
    </li>
  );
}
