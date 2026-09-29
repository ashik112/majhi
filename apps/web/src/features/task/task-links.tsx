import type { Task } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { Link2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Menu } from "@/components/ui/menu";
import { Modal } from "@/components/ui/modal";
import { UsageBar } from "@/components/ui/usage-bar";
import { cn } from "@/lib/cn";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useLinkTask, useTasks, useUnlinkTask } from "@/lib/task-queries";
import { TaskChips } from "../new-task/task-chips";
import { linkTargets, relations } from "./model";

type Picking = "parent" | "depends-on" | null;

/** Parent, what the task waits on and its children, with a menu to add or remove links. */
export function TaskLinks({ task }: { task: Task }) {
  const list = useTasks().data ?? [];
  const { org } = useOrgFilter();
  const unlink = useUnlinkTask();
  const [picking, setPicking] = useState<Picking>(null);
  const rel = relations(task, list);
  const search = orgSearch(org);
  const idLink = "font-mono text-fg hover:underline";

  return (
    <div className="flex flex-col gap-1.5 text-sm" data-testid="task-links">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {rel.parent && (
          <span className="flex items-center gap-1.5 text-fg-muted">
            Part of{" "}
            <Link
              to="/t/$taskId"
              params={{ taskId: rel.parent.id }}
              search={search}
              title={rel.parent.title}
              className={idLink}
            >
              {rel.parent.id}
            </Link>
            <RemoveLink
              label={`Remove link to ${rel.parent.id}`}
              onClick={() => unlink.mutate({ task: task.id, type: "parent", target: rel.parent?.id ?? "" })}
            />
          </span>
        )}
        {rel.depends.map((d) => (
          <span
            key={d.id}
            className={cn("flex items-center gap-1.5", d.waiting ? "text-coral" : "text-fg-muted")}
          >
            {d.waiting ? "Waiting on" : "After"}{" "}
            <Link
              to="/t/$taskId"
              params={{ taskId: d.id }}
              search={search}
              title={d.title}
              className={cn(idLink, d.waiting && "text-coral")}
            >
              {d.id}
            </Link>
            <RemoveLink
              label={`Remove link to ${d.id}`}
              onClick={() => unlink.mutate({ task: task.id, type: "depends-on", target: d.id })}
            />
          </span>
        ))}
        <Menu
          label="Add link"
          align="left"
          items={[
            {
              label: "Make child of...",
              onSelect: () => setPicking("parent"),
              disabled: rel.parent !== undefined,
            },
            { label: "Waits for...", onSelect: () => setPicking("depends-on") },
          ]}
          trigger={({ ref, ...props }) => (
            <Button ref={ref} {...props} variant="ghost" size="sm" className="-ml-2 text-fg-muted">
              <Link2 aria-hidden="true" />
              Add link
            </Button>
          )}
        />
      </div>

      {rel.children.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <span className="text-fg-muted">
              {rel.progress ? `${rel.progress.done} of ${rel.progress.total} done` : "Subtasks"}
            </span>
            {rel.progress && rel.progress.total > 0 && (
              <span className="w-28">
                <UsageBar pct={(rel.progress.done / rel.progress.total) * 100} tone="green" height={3} />
              </span>
            )}
          </div>
          <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
            {rel.children.map((c) => (
              <li key={c.id} className="flex items-center gap-1.5 text-fg-muted">
                <Link
                  to="/t/$taskId"
                  params={{ taskId: c.id }}
                  search={search}
                  title={c.title}
                  className={idLink}
                >
                  {c.id}
                </Link>
                <span className="text-fg-faint">{c.status === "done" ? "done" : c.status}</span>
                <RemoveLink
                  label={`Remove ${c.id} from this task`}
                  onClick={() => unlink.mutate({ task: c.id, type: "parent", target: task.id })}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {unlink.error && (
        <p role="alert" className="text-sm text-red">
          {unlink.error.message}
        </p>
      )}
      {picking && <LinkPicker task={task} type={picking} onClose={() => setPicking(null)} />}
    </div>
  );
}

function RemoveLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-5 cursor-pointer place-items-center rounded-xs text-fg-faint transition-colors duration-150 hover:text-fg"
    >
      <X aria-hidden="true" className="size-3" />
    </button>
  );
}

const COPY = {
  parent: { title: "Make child of", group: "Parent task" },
  "depends-on": { title: "Waits for", group: "Waits for" },
} as const;

function LinkPicker({
  task,
  type,
  onClose,
}: {
  task: Task;
  type: "parent" | "depends-on";
  onClose: () => void;
}) {
  const list = useTasks().data ?? [];
  const link = useLinkTask();
  const [target, setTarget] = useState<string[]>([]);
  const [when, setWhen] = useState<"merged" | "ready">("merged");
  const choices = linkTargets(task, list, type);

  function submit() {
    const id = target[0];
    if (id === undefined) return;
    link.mutate(
      { task: task.id, type, target: id, ...(type === "depends-on" ? { when } : {}) },
      { onSuccess: onClose },
    );
  }

  return (
    <Modal label={COPY[type].title} onClose={onClose} className="w-[560px]">
      <div className="flex flex-col gap-4 px-6 py-[22px]">
        <h2 className="text-[18px] font-semibold">
          {COPY[type].title} ({task.id})
        </h2>
        {choices.length === 0 ? (
          <p className="text-sm text-fg-muted">No other open tasks to link to.</p>
        ) : (
          <TaskChips label={COPY[type].group} tasks={choices} selected={target} onChange={setTarget} single />
        )}
        {type === "depends-on" && (
          <fieldset
            aria-label="Counts as met"
            className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
          >
            <span className="text-sm text-fg-faint">Met when it is</span>
            <ChoiceChip pressed={when === "merged"} onClick={() => setWhen("merged")}>
              Done
            </ChoiceChip>
            <ChoiceChip pressed={when === "ready"} onClick={() => setWhen("ready")}>
              Ready for review
            </ChoiceChip>
          </fieldset>
        )}
        {link.error && (
          <p
            role="alert"
            className="rounded-md border border-red-line bg-red-wash px-3 py-2 text-sm text-red text-pretty"
          >
            {link.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2.5">
          <Button variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={target.length === 0 || link.isPending}
            onClick={submit}
          >
            Add link
          </Button>
        </div>
      </div>
    </Modal>
  );
}
