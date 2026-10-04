import type { CleanupStep, CommandOutput } from "@majhi/shared";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { toneText } from "@/components/ui/status-dot";
import { useToast } from "@/components/ui/toast";
import { useSaveSettings, useSettings } from "@/lib/boss-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { usePreviewCleanup, useRunCleanup } from "@/lib/ops-queries";
import { parseDays, stepText, taskTotals } from "./cleanup-model";
import { FreeSpaceSettings } from "./free-space-settings";

type Preview = CommandOutput<"cleanup.preview">;
type Report = CommandOutput<"cleanup.run">;

/**
 * Cleanup of done tasks: the days after which a done task is offered, a preview of what a cleanup
 * would remove for each, and a confirm step before anything is deleted. The server checks each task
 * again when it runs, so a stale preview cannot remove more than it showed.
 */
export function CleanupPanel() {
  const settings = useSettings();
  const save = useSaveSettings();
  const preview = usePreviewCleanup();
  const run = useRunCleanup();
  const toast = useToast();
  const saved = settings.data?.cleanup.after_days;
  const [text, setText] = useState<string>();
  const [shown, setShown] = useState<Preview>();
  const [report, setReport] = useState<Report>();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [cachesOnly, setCachesOnly] = useState(false);

  const field = text ?? (saved === undefined ? "" : String(saved));
  const days = parseDays(field);
  const changed = days !== undefined && days !== saved;
  const tasks = shown?.tasks ?? [];
  const chosen = tasks.filter((t) => picked.has(t.id));
  const totals = taskTotals(chosen);

  function onPreview(onlyCaches = false) {
    if (days === undefined) return;
    setReport(undefined);
    if (changed && !onlyCaches) {
      save.mutate(
        { cleanup: { after_days: days } },
        { onError: (e) => toast("Could not save the days", { detail: describeError(e), tone: "error" }) },
      );
    }
    preview.mutate(
      { days, cachesOnly: onlyCaches },
      {
        onSuccess: (out) => {
          setShown(out);
          setPicked(
            new Set(out.tasks.filter((t) => taskTotals([t]).removes > 0 || t.roomItems > 0).map((t) => t.id)),
          );
        },
      },
    );
  }

  function onConfirm() {
    if (shown === undefined) return;
    run.mutate(
      { tasks: chosen.map((t) => t.id), days: shown.days, cachesOnly },
      {
        onSuccess: (out) => {
          setConfirming(false);
          setReport(out);
          setShown(undefined);
          setPicked(new Set());
        },
      },
    );
  }

  return (
    <section aria-label="Cleanup of done tasks" className={cn("flex shrink-0 flex-col rounded-2xl", GLASS)}>
      <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <h2 className="text-base font-semibold">Cleanup of done tasks</h2>
        <div className="flex items-center gap-2 text-sm text-fg-soft">
          <label htmlFor="cleanup-days">Done for more than</label>
          <Input
            id="cleanup-days"
            aria-label="Days after which a done task is offered for cleanup"
            inputMode="numeric"
            value={field}
            aria-invalid={field !== "" && days === undefined ? true : undefined}
            onChange={(event) => setText(event.target.value)}
            className="h-8 w-16 text-center"
          />
          <label htmlFor="cleanup-days">days</label>
        </div>
        {changed && (
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                { cleanup: { after_days: days } },
                {
                  onSuccess: () => {
                    setText(undefined);
                    toast("Cleanup days saved");
                  },
                  onError: (e) =>
                    toast("Could not save the days", { detail: describeError(e), tone: "error" }),
                },
              )
            }
          >
            Save days
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={days === undefined || preview.isPending}
          onClick={() => onPreview(false)}
        >
          {preview.isPending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Preview
        </Button>
        <Button size="sm" disabled={days === undefined || preview.isPending} onClick={() => onPreview(true)}>
          Preview dependency caches
        </Button>
        {field !== "" && days === undefined && (
          <p role="alert" className="text-sm text-red">
            Use a whole number of days, 1 or more.
          </p>
        )}
        {preview.isError && (
          <p role="alert" className="text-sm text-red">
            {describeError(preview.error)}
          </p>
        )}
      </div>

      <FreeSpaceSettings />

      {shown !== undefined && (
        <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
          {tasks.length === 0 ? (
            <p role="status" className="text-sm text-fg-muted">
              Nothing to clean up: no task has been done for more than {shown.days} days and still holds a
              worktree, a merged branch or room logs.
            </p>
          ) : (
            <>
              <ul
                aria-label="Tasks to clean up"
                className="flex max-h-[22dvh] flex-col gap-1 overflow-y-auto overscroll-contain scroll-fade"
              >
                {tasks.map((task) => (
                  <li key={task.id} className="rounded-md px-2 py-1.5">
                    <label className="flex min-w-0 items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={picked.has(task.id)}
                        onChange={(event) => {
                          const next = new Set(picked);
                          if (event.target.checked) next.add(task.id);
                          else next.delete(task.id);
                          setPicked(next);
                        }}
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="font-mono text-sm text-fg-soft">{task.id}</span>
                          <span className="truncate text-sm font-medium">{task.title}</span>
                          <span className="ml-auto shrink-0 text-xs text-fg-faint">
                            done {task.doneAt.slice(0, 10)}
                          </span>
                        </span>
                        <StepList steps={task.steps} roomItems={task.roomItems} />
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={chosen.length === 0 || run.isPending}
                  onClick={() => {
                    setCachesOnly(shown.cachesOnly === true);
                    setConfirming(true);
                  }}
                >
                  {shown.cachesOnly ? "Free caches for" : "Clean up"} {chosen.length}{" "}
                  {chosen.length === 1 ? "task" : "tasks"}
                </Button>
                <Button
                  size="sm"
                  disabled={
                    run.isPending ||
                    !chosen.some((t) => t.steps.some((s) => s.kind === "cache" && s.action === "remove"))
                  }
                  onClick={() => {
                    setCachesOnly(true);
                    setConfirming(true);
                  }}
                >
                  Free dependency caches
                </Button>
                <span className="text-sm text-fg-faint">
                  Nothing is forced: worktrees with changes and unmerged branches stay.
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {report !== undefined && (
        <section aria-label="Cleanup report" className="flex flex-col gap-1 border-t border-line px-4 py-3">
          <p role="status" className="text-sm font-medium">
            Cleanup finished
          </p>
          <ul className="flex max-h-[22dvh] flex-col gap-1.5 overflow-y-auto overscroll-contain scroll-fade">
            {report.tasks.map((task) => (
              <li key={task.id} className="flex flex-col gap-0.5 text-sm">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="font-mono text-fg-soft">{task.id}</span>
                  <span className="truncate">{task.title}</span>
                </span>
                {task.skipped === undefined ? (
                  <StepList steps={task.steps} roomItems={task.roomItems} done />
                ) : (
                  <span className={toneText("amber")}>Left alone: {task.skipped}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirming && (
        <ConfirmDialog
          title={
            cachesOnly
              ? "Free dependency caches?"
              : `Clean up ${chosen.length} ${chosen.length === 1 ? "task" : "tasks"}?`
          }
          body={
            cachesOnly ? (
              "Remove only ignored dependency and tool caches from the selected done tasks. Source changes, branches and room history stay. Dependencies can be installed again when needed."
            ) : (
              <>
                This removes {totals.removes}{" "}
                {totals.removes === 1 ? "worktree, branch or cache" : "worktrees, branches and caches"} and
                deletes {totals.roomItems} room items. Each task keeps one note and its memory. It cannot be
                undone. majhi checks every task again first.
              </>
            )
          }
          confirmLabel={cachesOnly ? "Free caches" : "Clean up"}
          busy={run.isPending}
          error={run.isError ? describeError(run.error) : undefined}
          onConfirm={onConfirm}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}

/** What is removed and what is kept for one task, one line each. `done` words them in the past. */
function StepList({
  steps,
  roomItems,
  done = false,
}: {
  steps: readonly CleanupStep[];
  roomItems: number;
  done?: boolean;
}) {
  return (
    <ul className="flex flex-col gap-0.5 text-sm">
      {steps.map((step) => (
        <li
          key={`${step.kind}:${step.name}`}
          className={cn(step.action === "skip" ? toneText("amber") : "text-fg-muted")}
        >
          {stepText(step, done)}
        </li>
      ))}
      {roomItems > 0 && (
        <li className="text-fg-muted">
          {done ? "Deleted" : "Delete"} {roomItems} room items, keeping one note
        </li>
      )}
    </ul>
  );
}
