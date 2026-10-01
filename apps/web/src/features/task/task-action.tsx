import type { Task } from "@majhi/shared";
import { Check, OctagonX, Play, RotateCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { ApiRequestError } from "@/lib/api";
import { useCloseTask, useShipOptions, useStartTask, useStopTask } from "@/lib/task-queries";
import { actionCopy } from "./model";
import { Ship, useDirectShip } from "./ship";
import { CloseUnshippedDialog, unshippedCount } from "./unshipped";

/** The task's one main action in the header. What it does is in the tooltip; a pause reason shows beside it. */
export function TaskAction({ task, yourTurn }: { task: Task; yourTurn: boolean }) {
  const start = useStartTask();
  const stop = useStopTask();
  const close = useCloseTask();
  const toast = useToast();
  const copy = actionCopy(task, yourTurn);
  const ship = useDirectShip(task);
  const options = useShipOptions(task, copy.kind === "done");
  const unshipped = options.data?.done.unshipped ?? [];
  const [confirming, setConfirming] = useState(false);
  // Only once there is work to ship: a worktree exists and no agent is working.
  const canShip =
    task.repos.some((r) => r.worktree !== undefined) &&
    !["inbox", "ready", "running", "done"].includes(task.status);
  const fail = (title: string) => (error: ApiRequestError) =>
    toast(title, { detail: error.message, tone: "error" });

  return (
    <>
      {canShip && <Ship task={task} run={ship} />}
      {copy.warm && <span className="mr-1 max-w-[320px] truncate text-xs text-lamp-paused">{copy.text}</span>}
      {copy.kind === "start" && (
        <Button
          variant="primary"
          size="sm"
          title={copy.text}
          disabled={start.isPending}
          onClick={() => start.mutate(task.id, { onError: fail("Could not start") })}
        >
          <Play aria-hidden="true" />
          Start
        </Button>
      )}
      {copy.kind === "resume" && (
        <Button
          variant="primary"
          size="sm"
          title={copy.text}
          disabled={start.isPending}
          onClick={() => start.mutate(task.id, { onError: fail("Could not resume") })}
        >
          <RotateCw aria-hidden="true" />
          Resume
        </Button>
      )}
      {copy.kind === "done" && unshipped.length > 0 && (
        <span className="mr-1 text-xs text-amber-soft">{unshippedCount(unshipped)}</span>
      )}
      {copy.kind === "done" && (
        <Button
          variant="primary"
          size="sm"
          title={copy.text}
          disabled={close.isPending}
          onClick={() =>
            unshipped.length > 0
              ? setConfirming(true)
              : close.mutate({ id: task.id }, { onError: fail("Could not mark it done") })
          }
        >
          <Check aria-hidden="true" />
          Mark done
        </Button>
      )}
      {confirming && (
        <CloseUnshippedDialog
          unshipped={unshipped}
          busy={close.isPending}
          error={close.error?.message}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            close.mutate({ id: task.id, unshipped: "keep" }, { onSuccess: () => setConfirming(false) })
          }
        />
      )}
      {copy.kind === "stop" && (
        <Button
          size="sm"
          title="Stop every agent in this task"
          disabled={stop.isPending}
          onClick={() => stop.mutate(task.id, { onError: fail("Could not stop") })}
        >
          <OctagonX aria-hidden="true" />
          Stop all
        </Button>
      )}
    </>
  );
}
