import type { Task } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisVertical } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Menu } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { ApiRequestError } from "@/lib/api";
import { useEditorLabel, useOpenInEditor } from "@/lib/editor-queries";
import { useCloseTask, useRemoveTask, useReopenTask } from "@/lib/task-queries";

/** The task's "..." menu: close it (moves to Done) or remove it with its folder and worktrees. */
export function TaskMenu({ task }: { task: Task }) {
  const [confirm, setConfirm] = useState<"close" | "remove" | null>(null);
  const reopen = useReopenTask();
  const toast = useToast();
  const open = useOpenInEditor();
  const editor = useEditorLabel();
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
          { label: "Remove task", onSelect: () => setConfirm("remove"), tone: "danger" },
        ]}
      />
      {confirm === "close" && <CloseDialog task={task} onDone={() => setConfirm(null)} />}
      {confirm === "remove" && <RemoveDialog task={task} onDone={() => setConfirm(null)} />}
    </>
  );
}

function CloseDialog({ task, onDone }: { task: Task; onDone: () => void }) {
  const close = useCloseTask();
  const toast = useToast();
  return (
    <ConfirmDialog
      title={`Close ${task.id}`}
      body="The task moves to Done. Its worktrees and branches stay until you remove the task."
      confirmLabel="Close task"
      busy={close.isPending}
      error={close.error?.message}
      onCancel={onDone}
      onConfirm={() =>
        close.mutate(task.id, {
          onSuccess: () => {
            toast("Task closed", { detail: task.id });
            onDone();
          },
        })
      }
    />
  );
}

/** Removing a task with uncommitted work is refused by the server; the dialog shows why and offers to force it. */
function RemoveDialog({ task, onDone }: { task: Task; onDone: () => void }) {
  const remove = useRemoveTask();
  const toast = useToast();
  const navigate = useNavigate();
  const [refused, setRefused] = useState(false);

  // Awaited instead of per-call callbacks: removing the task can unmount this view (the task
  // disappears from the list) before a per-call onSuccess would run, and then it never runs.
  async function run(force: boolean) {
    try {
      await remove.mutateAsync(force ? { id: task.id, force: true } : { id: task.id });
    } catch (error) {
      setRefused(error instanceof ApiRequestError && !error.unreachable);
      return;
    }
    toast("Task removed", { detail: task.id });
    onDone();
    void navigate({ to: "/" });
  }

  return (
    <ConfirmDialog
      title={`Remove ${task.id}`}
      body="This deletes the task, its folder and its worktrees. Branches already pushed stay on the remote."
      confirmLabel={refused ? "Remove anyway" : "Remove task"}
      busy={remove.isPending}
      error={remove.error ? [remove.error.message, ...remove.error.details].join(" ") : undefined}
      onCancel={onDone}
      onConfirm={() => void run(refused)}
    />
  );
}
