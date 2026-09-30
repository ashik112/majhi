import type { Task } from "@majhi/shared";
import { Check, GitMerge, OctagonX, Play, RotateCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { ApiRequestError } from "@/lib/api";
import { useCloseTask, useStartTask, useStopTask } from "@/lib/task-queries";
import { MergeDialog } from "./merge-dialog";
import { actionCopy } from "./model";

/** The task's one main action in the header. What it does is in the tooltip; a pause reason shows beside it. */
export function TaskAction({ task, yourTurn }: { task: Task; yourTurn: boolean }) {
  const start = useStartTask();
  const stop = useStopTask();
  const close = useCloseTask();
  const toast = useToast();
  const copy = actionCopy(task, yourTurn);
  const [merging, setMerging] = useState(false);
  const canMerge = task.repos.length > 0 && task.status !== "running";
  const fail = (title: string) => (error: ApiRequestError) =>
    toast(title, { detail: error.message, tone: "error" });

  return (
    <>
      {canMerge && (
        <Button
          size="sm"
          title="Merge the task branch into a local branch. Nothing is pushed."
          onClick={() => setMerging(true)}
        >
          <GitMerge aria-hidden="true" />
          Merge
        </Button>
      )}
      {merging && <MergeDialog task={task} onClose={() => setMerging(false)} />}
      {copy.warm && <span className="mr-1 max-w-[320px] truncate text-xs text-coral">{copy.text}</span>}
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
      {copy.kind === "done" && (
        <Button
          variant="primary"
          size="sm"
          title={copy.text}
          disabled={close.isPending}
          onClick={() => close.mutate(task.id, { onError: fail("Could not mark it done") })}
        >
          <Check aria-hidden="true" />
          Mark done
        </Button>
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
