import type { Task } from "@majhi/shared";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Markdown } from "@/features/room/markdown";
import { linkifyPaths } from "@/features/viewer/model";
import { cn } from "@/lib/cn";
import { useUpdateTask } from "@/lib/task-queries";

/**
 * What the owner wrote under the title, as markdown, folded to one line. File paths in it open in
 * the viewer, from the task's project. More unfolds it; Edit turns it into a text box.
 */
export function Brief({ text, task }: { text: string; task: Task }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const [folds, setFolds] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const update = useUpdateTask();
  const toast = useToast();
  const source = useMemo(() => linkifyPaths(text), [text]);
  const files = useMemo(
    () => ({ id: task.id, folder: task.folder, project: task.repos[0]?.project }),
    [task.id, task.folder, task.repos],
  );

  // More only when the folded text is really cut.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the text changes
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || open) return;
    const measure = () => setFolds(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [source, open]);

  if (editing) {
    return (
      <div className="flex max-w-[96ch] flex-col gap-2 pt-1">
        <textarea
          aria-label="Task description"
          // biome-ignore lint/a11y/noAutofocus: the owner just asked to edit it
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={6}
          className="max-h-[40vh] w-full resize-y rounded-md border border-line-control bg-field p-2 text-base text-fg focus-visible:border-accent focus-visible:outline-none"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                { id: task.id, brief: value },
                {
                  onSuccess: () => setEditing(false),
                  onError: (e) => toast("Could not save", { detail: e.message, tone: "error" }),
                },
              )
            }
          >
            Save
          </Button>
          <Button size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section
      aria-label="Task brief"
      className={cn("flex min-w-0 gap-x-3 gap-y-1", open ? "flex-col items-start" : "items-center")}
    >
      <div
        ref={body}
        className={cn(
          "min-w-0 max-w-[96ch] text-fg-muted [&_.md]:text-base [&_.md]:leading-5",
          open ? "max-h-[40vh] overflow-y-auto" : "max-h-5 overflow-hidden",
          !open && folds && "[mask-image:linear-gradient(to_right,black_85%,transparent)]",
        )}
      >
        <Markdown text={source} task={files} />
      </div>
      <div className={cn("flex shrink-0 items-center gap-1", open ? "-ml-1.5" : "")}>
        {(folds || open) && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="h-6 cursor-pointer rounded-sm px-1.5 text-sm text-blue hover:underline focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
          >
            {open ? "Show less" : "Show all"}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setValue(text);
            setEditing(true);
          }}
          className="h-6 cursor-pointer rounded-sm px-1.5 text-sm text-blue hover:underline focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
        >
          Edit
        </button>
      </div>
    </section>
  );
}
