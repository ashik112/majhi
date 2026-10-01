import type { Task, TaskSummary } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { Markdown } from "@/features/room/markdown";
import { describeError } from "@/lib/errors";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useReport, useStartTask, useTasks } from "@/lib/task-queries";

/** A fix task that was never started can be started from here. */
const startable = (t: TaskSummary) => t.status === "inbox" || t.status === "ready";

/**
 * The Report tab of an ops task: REPORT.md as the room shows markdown, and the fix tasks made
 * from it with their status and a Start button. A fix task starts only when the owner clicks it.
 */
export function ReportTab({ task }: { task: Task }) {
  const report = useReport(task.id);
  const list = useTasks().data ?? [];
  const { org } = useOrgFilter();
  const start = useStartTask();
  const toast = useToast();
  const files = useMemo(
    () => ({ id: task.id, folder: task.folder, project: task.repos[0]?.project }),
    [task.id, task.folder, task.repos],
  );
  const fixes = list
    .filter((t) => t.links.some((l) => l.type === "follow-up" && l.task === task.id))
    .toSorted((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const content = report.data ?? null;

  return (
    <section
      aria-label="Report"
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain pr-1 pb-6 scroll-fade"
    >
      {fixes.length > 0 && (
        <div className="flex max-w-[96ch] flex-col gap-2">
          <SectionLabel>Fix tasks</SectionLabel>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {fixes.map((fix) => (
              <li
                key={fix.id}
                className="flex min-w-0 items-center gap-3 rounded-lg border border-glass-line bg-card px-3 py-2"
              >
                <Link
                  to="/t/$taskId"
                  params={{ taskId: fix.id }}
                  search={orgSearch(org)}
                  className="flex min-w-0 flex-1 items-center gap-2 hover:text-fg"
                >
                  <span className="shrink-0 font-mono text-xs text-fg-muted">{fix.id}</span>
                  <span className="min-w-0 truncate text-base">{fix.title}</span>
                </Link>
                <StatusBadge status={fix.status} pausedReason={fix.pausedReason} />
                {startable(fix) && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={start.isPending}
                    aria-label={`Start ${fix.id}`}
                    onClick={() =>
                      start.mutate(fix.id, {
                        onError: (e) => toast("Could not start", { detail: describeError(e), tone: "error" }),
                      })
                    }
                  >
                    Start
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.isError ? (
        <p role="alert" className="text-base text-fg-soft text-pretty">
          Could not read REPORT.md. {report.error.message}
        </p>
      ) : content === null ? (
        report.isPending ? (
          <p className="text-sm text-fg-faint">Loading the report</p>
        ) : (
          <div className="flex max-w-[60ch] flex-col gap-1">
            <p className="text-md font-medium">No report yet</p>
            <p className="text-base text-fg-muted text-pretty">
              The agent writes REPORT.md in the task folder when it has findings.
            </p>
          </div>
        )
      ) : (
        <div className="flex max-w-[96ch] flex-col gap-2">
          <p className="text-xs text-fg-faint">
            REPORT.md · updated <time dateTime={content.modifiedAt}>{when(content.modifiedAt)}</time>
          </p>
          <Markdown text={content.content} task={files} size="document" />
        </div>
      )}
    </section>
  );
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
