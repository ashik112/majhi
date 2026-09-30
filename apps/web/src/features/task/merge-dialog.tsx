import type { CommandOutput, Task } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { useMergeTask, useTaskBranches } from "@/lib/task-queries";

type Result = CommandOutput<"tasks.merge">["results"][number];

/** Pick a local branch (the base by default, or dev, staging, ...) and merge the task into it. Never pushes. */
export function MergeDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const branches = useTaskBranches(task.id, true);
  const merge = useMergeTask();
  const base = task.repos[0]?.base ?? "main";
  const [into, setInto] = useState(base);
  const [done, setDone] = useState(task.status === "review");
  const [results, setResults] = useState<Result[]>();
  const choices = [...new Set([base, ...(branches.data ?? []).flatMap((r) => r.branches)])];
  const clean = results?.every((r) => r.ok) ?? false;

  return (
    <Modal label="Merge" onClose={onClose} className="w-[480px]">
      <div className="flex flex-col gap-4 px-6 py-5">
        <h2 className="text-md font-semibold">Merge {task.id}</h2>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-fg-muted">Into branch</span>
          <input
            list={`branches-${task.id}`}
            value={into}
            onChange={(e) => setInto(e.target.value)}
            className="h-9 rounded-md border border-line-control bg-field px-2.5 font-mono text-base text-fg focus-visible:border-blue focus-visible:outline-none"
          />
          <datalist id={`branches-${task.id}`}>
            {choices.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
          <span className="text-xs text-fg-faint">
            {task.repos.map((r) => r.branch).join(", ")} into {into || "..."} in your checkout. Nothing is
            pushed.
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />
          Mark the task done after a clean merge
        </label>
        {results && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {results.map((r) => (
              <li key={r.project} className={cn(r.ok ? "text-green" : "text-red", "text-pretty")}>
                {task.repos.length > 1 && <span className="font-mono">{r.project}: </span>}
                {r.detail}
              </li>
            ))}
          </ul>
        )}
        {merge.error && (
          <p role="alert" className="text-sm text-red text-pretty">
            {merge.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {clean ? "Close" : "Cancel"}
          </Button>
          {!clean && (
            <Button
              variant="primary"
              disabled={merge.isPending || into.trim() === ""}
              onClick={() =>
                merge.mutate(
                  { id: task.id, into: into.trim(), done },
                  { onSuccess: (out) => setResults(out.results) },
                )
              }
            >
              {merge.isPending ? "Merging..." : `Merge into ${into.trim() || "..."}`}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
