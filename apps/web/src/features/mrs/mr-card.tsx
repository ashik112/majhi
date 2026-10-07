import { reviewLine, type Task, type TaskRepo } from "@majhi/shared";
import { ArrowDown, ArrowUp, ExternalLink, GitPullRequest } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useMergeOrder, useMrCommand, useTaskDetail } from "@/lib/task-queries";
import {
  CI_LABEL,
  CI_TONE,
  inMergeOrder,
  MERGE_BY_LABEL,
  MR_STATE_LABEL,
  type MrStep,
  moveProject,
  nextMrStep,
} from "./model";

type Dialog = "open" | "merge" | "mark" | null;

/** Merge requests of a task: one row per repo in merge order, what each is doing, and the next step. */
export function MrCard({ task }: { task: Task }) {
  const mergeBy = useTaskDetail(task.id).data?.ship?.merge ?? "owner";
  const order = useMergeOrder(task.id, task.repos.length > 0);
  const setOrder = useMrCommand("tasks.setMergeOrder");
  const toast = useToast();
  const rows = inMergeOrder(task.repos, order.data?.order);
  const step = nextMrStep(task, mergeBy);
  const canReorder = rows.length > 1 && step !== "done" && order.data !== undefined;

  function move(project: string, by: -1 | 1) {
    if (!order.data) return;
    setOrder.mutate(
      { id: task.id, order: moveProject(order.data.order, project, by) },
      { onError: (e) => toast("Could not change the order", { detail: e.message, tone: "error" }) },
    );
  }

  return (
    <Card aria-labelledby="mr-heading" className="gap-2 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <h2 id="mr-heading" className="text-sm font-semibold">
          Merge requests
        </h2>
        {order.data?.overridden && (
          <button
            type="button"
            disabled={setOrder.isPending}
            onClick={() => setOrder.mutate({ id: task.id, order: null })}
            className="ml-auto cursor-pointer rounded-xs text-xs text-fg-muted hover:text-fg"
          >
            Use the order from links
          </button>
        )}
      </div>
      {order.isError && (
        <p role="alert" className="text-sm text-red text-pretty">
          {order.error.message}
        </p>
      )}
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rows.map((repo, i) => (
          <MrRow
            key={repo.project}
            repo={repo}
            place={i + 1}
            showPlace={rows.length > 1}
            onUp={canReorder && i > 0 ? () => move(repo.project, -1) : undefined}
            onDown={canReorder && i < rows.length - 1 ? () => move(repo.project, 1) : undefined}
            busy={setOrder.isPending}
          />
        ))}
      </ol>
      <p className="text-xs text-fg-faint text-pretty">{MERGE_BY_LABEL[mergeBy]}</p>
      <MrActions task={task} step={step} />
    </Card>
  );
}

function MrRow({
  repo,
  place,
  showPlace,
  onUp,
  onDown,
  busy,
}: {
  repo: TaskRepo;
  place: number;
  showPlace: boolean;
  onUp: (() => void) | undefined;
  onDown: (() => void) | undefined;
  busy: boolean;
}) {
  const mr = repo.mr;
  return (
    <li className="flex items-center gap-1.5 rounded-md border border-line-strong bg-card px-2 py-1.5">
      {showPlace && <span className="tnum w-3 shrink-0 font-mono text-xs text-fg-faint">{place}</span>}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-xs text-fg-soft">{repo.project}</span>
        {mr ? (
          <span className="flex flex-wrap items-center gap-x-1.5 text-xs">
            <a
              href={mr.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-0.5 text-fg-muted hover:text-fg"
            >
              #{mr.number}
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
            <span className={mr.state === "merged" ? "text-green" : "text-fg-muted"}>
              {MR_STATE_LABEL[mr.state]}
            </span>
            {mr.state === "open" && <span className={cn(CI_TONE[mr.ci])}>{CI_LABEL[mr.ci]}</span>}
            {mr.state === "open" && reviewLine(mr.review) !== undefined && (
              <span className={mr.review?.changesRequested ? "text-red" : "text-fg-muted"}>
                {reviewLine(mr.review)}
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs text-fg-faint">No MR yet</span>
        )}
      </div>
      {(onUp || onDown) && (
        <span className="flex shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6"
            aria-label={`Merge ${repo.project} earlier`}
            disabled={!onUp || busy}
            onClick={onUp}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6"
            aria-label={`Merge ${repo.project} later`}
            disabled={!onDown || busy}
            onClick={onDown}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
        </span>
      )}
    </li>
  );
}

function MrActions({ task, step }: { task: Task; step: MrStep }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const open = useMrCommand("tasks.openMrs");
  const refresh = useMrCommand("tasks.refreshMrs");
  const merge = useMrCommand("tasks.mergeMrs");
  const mark = useMrCommand("tasks.markMerged");
  const toast = useToast();
  const fail = (title: string) => (e: Error) => toast(title, { detail: e.message, tone: "error" });
  const close = () => {
    setDialog(null);
    open.reset();
    merge.reset();
    mark.reset();
  };
  const hasMr = task.repos.some((r) => r.mr !== undefined);
  const projects = task.repos.map((r) => r.project).join(", ");
  const stillOpen = mark.data?.stillOpen ?? [];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {step === "retry-open" && (
          <Button size="sm" variant="primary" onClick={() => setDialog("open")}>
            <GitPullRequest aria-hidden="true" />
            Open the missing MRs
          </Button>
        )}
        {(step === "merge" || step === "watch") && (
          <Button size="sm" variant="primary" onClick={() => setDialog("merge")}>
            {step === "merge" ? "Merge in order" : "Merge now"}
          </Button>
        )}
        {(step === "merge" || step === "watch") && (
          <Button size="sm" onClick={() => setDialog("mark")}>
            I merged it
          </Button>
        )}
        {hasMr && step !== "done" && (
          <Button
            size="sm"
            disabled={refresh.isPending}
            title="Read each MR's state and checks from its host"
            onClick={() => refresh.mutate({ id: task.id }, { onError: fail("Could not refresh") })}
          >
            {refresh.isPending ? "Checking..." : "Refresh"}
          </Button>
        )}
      </div>
      {step === "watch" && (
        <p className="text-xs text-fg-faint text-pretty">
          majhi merges in order as soon as checks pass. You do not need to click.
        </p>
      )}
      {notes.map((note) => (
        <p key={note} className="text-xs text-fg-muted text-pretty">
          {note}
        </p>
      ))}
      {dialog === "open" && (
        <ConfirmDialog
          title={`Open merge requests for ${task.id}`}
          body={`This pushes the branch of ${projects} to each project's MR remote and opens one merge request per repo. Repos with no new commit are skipped. Nothing merges yet.`}
          confirmLabel="Push and open"
          busy={open.isPending}
          error={open.error?.message}
          onCancel={close}
          onConfirm={() =>
            open.mutate(
              { id: task.id },
              {
                onSuccess: (out) => {
                  setNotes(out.repos.map((r) => `${r.project}: ${r.detail}`));
                  setDialog(null);
                },
              },
            )
          }
        />
      )}
      {dialog === "merge" && (
        <ConfirmDialog
          title={`Merge ${task.id}`}
          body="majhi merges the MRs on their hosts, first in the merge order, and stops at the first one that fails or has failing checks. When every MR is merged the task is done and its worktrees are removed."
          confirmLabel="Merge in order"
          busy={merge.isPending}
          error={merge.error?.message}
          onCancel={close}
          onConfirm={() =>
            merge.mutate(
              { id: task.id },
              {
                onSuccess: (out) => {
                  setNotes(
                    out.stoppedAt
                      ? [
                          ...out.merged.map((p) => `${p}: merged`),
                          `Stopped at ${out.stoppedAt.project}: ${out.stoppedAt.reason}`,
                        ]
                      : out.merged.map((p) => `${p}: merged`),
                  );
                  setDialog(null);
                },
              },
            )
          }
        />
      )}
      {dialog === "mark" && (
        <ConfirmDialog
          title="Record the merge"
          body={
            <>
              <p>
                majhi checks each MR with its host. When all are merged the task is done and its worktrees are
                removed.
              </p>
              {stillOpen.length > 0 && (
                <p className="mt-2 text-amber">
                  The host still shows {stillOpen.map((s) => `${s.project} as ${s.state}`).join(", ")}.
                  Confirm again to record it as merged anyway.
                </p>
              )}
            </>
          }
          confirmLabel={stillOpen.length > 0 ? "Record as merged anyway" : "I merged it"}
          busy={mark.isPending}
          error={mark.error?.message}
          onCancel={close}
          onConfirm={() =>
            mark.mutate(
              { id: task.id, force: stillOpen.length > 0 },
              {
                onSuccess: (out) => {
                  if (out.stillOpen.length === 0) {
                    setNotes([]);
                    setDialog(null);
                  }
                },
              },
            )
          }
        />
      )}
    </div>
  );
}
