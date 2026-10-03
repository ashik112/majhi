import { type Task, TRACKER_LABEL } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisVertical } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Menu } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { ApiRequestError } from "@/lib/api";
import { useEditorLabel, useOpenInEditor } from "@/lib/editor-queries";
import { useOrgs } from "@/lib/studio-queries";
import { useCloseTask, useRemoveTask, useReopenTask, useShipOptions } from "@/lib/task-queries";
import { useTrackerCommand, useTrackerLink } from "@/lib/tracker-queries";
import { unshippedBody } from "./unshipped";

/** The task's "..." menu: close it (moves to Done) or remove it with its folder and worktrees. */
export function TaskMenu({ task }: { task: Task }) {
  const [confirm, setConfirm] = useState<"close" | "remove" | null>(null);
  const reopen = useReopenTask();
  const toast = useToast();
  const open = useOpenInEditor();
  const editor = useEditorLabel();
  const tracker = useOrgs().data?.find((o) => o.id === task.org)?.tracker;
  const link = useTrackerLink(task.id);
  const push = useTrackerCommand("trackers.push");
  const unlink = useTrackerCommand("trackers.unlink");
  const trackerItems =
    link !== undefined
      ? [
          {
            label: `Unlink from ${link.key}`,
            onSelect: () =>
              unlink.mutate(
                { id: task.id },
                { onError: (e) => toast("Could not unlink", { detail: e.message, tone: "error" }) },
              ),
          },
        ]
      : tracker !== undefined
        ? [
            {
              label: `Push to ${TRACKER_LABEL[tracker.type]}`,
              onSelect: () =>
                push.mutate(
                  { id: task.id },
                  {
                    onSuccess: (l) => toast(`Pushed to ${TRACKER_LABEL[l.type]}`, { detail: l.key }),
                    onError: (e) => toast("Could not push", { detail: e.message, tone: "error" }),
                  },
                ),
            },
          ]
        : [];
  return (
    <>
      <Menu
        label="Task menu"
        icon={<EllipsisVertical aria-hidden="true" />}
        items={[
          task.status === "done"
            ? {
                label: "Reopen task",
                onSelect: () =>
                  reopen.mutate(task.id, {
                    onError: (e) => toast("Could not reopen", { detail: e.message, tone: "error" }),
                  }),
              }
            : { label: "Close task", onSelect: () => setConfirm("close") },
          {
            label: `Open folder in ${editor}`,
            onSelect: () =>
              open.mutate(
                { path: task.folder },
                {
                  onSuccess: (done) => toast(`Opened in ${editor}`, { detail: done.path }),
                  onError: (e) => toast(`Could not open in ${editor}`, { detail: e.message, tone: "error" }),
                },
              ),
          },
          ...trackerItems,
          { label: "Remove task", onSelect: () => setConfirm("remove"), tone: "danger" },
        ]}
      />
      {confirm === "close" && <CloseDialog task={task} onDone={() => setConfirm(null)} />}
      {confirm === "remove" && <RemoveDialog task={task} onDone={() => setConfirm(null)} />}
    </>
  );
}

/** Work not shipped turns the dialog into the one confirmation to close without shipping. */
function CloseDialog({ task, onDone }: { task: Task; onDone: () => void }) {
  const close = useCloseTask();
  const toast = useToast();
  const options = useShipOptions(task, true);
  const unshipped = options.data?.done.unshipped ?? [];
  const keep = unshipped.length > 0;
  return (
    <ConfirmDialog
      title={keep ? "Close without shipping?" : `Close ${task.id}`}
      body={
        keep
          ? unshippedBody(unshipped)
          : "The task moves to Done. Its worktrees and branches stay until you remove the task."
      }
      confirmLabel={keep ? "Close anyway" : "Close task"}
      busy={close.isPending || options.isPending}
      error={close.error?.message}
      onCancel={onDone}
      onConfirm={() =>
        close.mutate(keep ? { id: task.id, unshipped: "keep" } : { id: task.id }, {
          onSuccess: () => {
            toast("Task closed", { detail: task.id });
            onDone();
          },
        })
      }
    />
  );
}

/**
 * Removing a task with uncommitted work is refused by the server with the list of changes. The dialog
 * then shows them and removes the task only after the owner types its id.
 */
function RemoveDialog({ task, onDone }: { task: Task; onDone: () => void }) {
  const remove = useRemoveTask();
  const toast = useToast();
  const navigate = useNavigate();
  const [refusal, setRefusal] = useState<{ message: string; changes: string[]; again: boolean } | null>(null);
  const [typed, setTyped] = useState("");
  const confirmed = typed.trim().toUpperCase() === task.id;

  // Awaited instead of per-call callbacks: removing the task can unmount this view (the task
  // disappears from the list) before a per-call onSuccess would run, and then it never runs.
  async function run() {
    try {
      await remove.mutateAsync(
        refusal === null ? { id: task.id } : { id: task.id, force: true, confirm: typed.trim() },
      );
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409 && error.details.length > 0) {
        setRefusal({ message: error.message, changes: error.details, again: refusal !== null });
        setTyped("");
        remove.reset();
      }
      return;
    }
    toast("Task removed", { detail: task.id });
    onDone();
    void navigate({ to: "/" });
  }

  const body =
    refusal === null ? (
      "This deletes the task, its folder and its worktrees. Branches already pushed stay on the remote."
    ) : (
      <div className="flex flex-col gap-3">
        <p>
          {refusal.again
            ? refusal.message
            : "These changes are in no commit. Removing the task deletes them for good."}
        </p>
        <ul className="max-h-40 overflow-auto rounded-md border border-line bg-field px-3 py-2 font-mono text-sm text-fg">
          {refusal.changes.map((line) => (
            <li key={line} className="truncate" title={line}>
              {line}
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`remove-${task.id}`}>Type {task.id} to remove the task and these changes.</label>
          <Input
            id={`remove-${task.id}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={task.id}
            className="font-mono"
          />
        </div>
      </div>
    );

  return (
    <ConfirmDialog
      title={`Remove ${task.id}`}
      body={body}
      confirmLabel={refusal === null ? "Remove task" : "Remove with changes"}
      busy={remove.isPending}
      confirmDisabled={refusal !== null && !confirmed}
      error={remove.error ? [remove.error.message, ...remove.error.details].join(" ") : undefined}
      onCancel={onDone}
      onConfirm={() => void run()}
    />
  );
}
