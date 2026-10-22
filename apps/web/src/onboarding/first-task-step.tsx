import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { describeError } from "@/lib/errors";
import { useCreateTask, useProjects } from "@/lib/task-queries";
import { Problem } from "./step-frame";

/** Step 3: one text box and Start. The task starts at once, in the project picked beside the button. */
export function FirstTaskStep({
  onStarted,
  onSkip,
}: {
  /** The id of the task that was started. */
  onStarted: (task: string) => void;
  onSkip: () => void;
}) {
  const projects = useProjects().data ?? [];
  const create = useCreateTask();
  const [text, setText] = useState("");
  const [pick, setPick] = useState<string>();
  const project = projects.find((p) => p.id === pick) ?? projects[0];
  const example =
    project === undefined ? "Fix the flaky login test" : `Fix the flaky login test in ${project.id}`;

  function start() {
    if (text.trim() === "") return;
    create.mutate(
      {
        text: text.trim(),
        start: true,
        ...(project === undefined ? {} : { repos: [{ project: project.id }], org: project.org }),
      },
      { onSuccess: (task) => onStarted(task.id) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl border border-line-strong bg-card p-3">
        <textarea
          aria-label="The first task"
          // biome-ignore lint/a11y/noAutofocus: it is the only thing on the step
          autoFocus
          rows={4}
          value={text}
          placeholder={example}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
          }}
          className="w-full resize-none border-0 bg-transparent p-1 text-body text-fg outline-none placeholder:text-fg-faint"
        />
        <div className="flex items-center gap-3">
          {projects.length > 0 && (
            <Select
              aria-label="Project"
              value={project?.id ?? ""}
              onChange={(e) => setPick(e.target.value)}
              className="h-9 w-[180px] font-mono text-sm"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </Select>
          )}
          <Button
            variant="primary"
            size="lg"
            className="ml-auto"
            disabled={text.trim() === "" || create.isPending}
            onClick={start}
          >
            {create.isPending ? "Starting" : "Start task"}
          </Button>
        </div>
      </div>
      {create.isError && <Problem>{describeError(create.error)}</Problem>}
      <p className="m-0 text-sm text-fg-muted">
        Or{" "}
        <button
          type="button"
          onClick={onSkip}
          className="cursor-pointer text-fg-muted underline underline-offset-2 hover:text-fg"
        >
          skip and look around
        </button>
        . Git sign-in is asked the first time an agent needs to push.
      </p>
    </div>
  );
}
