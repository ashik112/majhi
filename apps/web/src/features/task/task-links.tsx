import type { Task } from "@majhi/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Menu } from "@/components/ui/menu";
import { Modal } from "@/components/ui/modal";
import { UsageBar } from "@/components/ui/usage-bar";
import { cn } from "@/lib/cn";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useLinkTask, useTasks, useUnlinkTask } from "@/lib/task-queries";
import { TaskChips } from "../new-task/task-chips";
import { linkTargets, relations, subtaskLine } from "./model";

type Picking = "parent" | "depends-on" | null;

type Unlinking = { task: string; type: "parent" | "depends-on"; target: string; label: string };

const chip =
  "flex h-6 min-w-0 items-center gap-1 rounded-md border border-line-control px-1.5 text-xs hover:border-line-hover";

/** One line of small chips: what the task is part of, what it waits for, its subtasks, and "Link". */
export function TaskLinks({ task }: { task: Task }) {
  const list = useTasks().data ?? [];
  const { org } = useOrgFilter();
  const navigate = useNavigate();
  const unlink = useUnlinkTask();
  const [picking, setPicking] = useState<Picking>(null);
  const [asking, setAsking] = useState<Unlinking | null>(null);
  const rel = relations(task, list);
  const search = orgSearch(org);
  const linkTo = (id: string) => ({ to: "/t/$taskId" as const, params: { taskId: id }, search });

  return (
    <div
      className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs"
      data-testid="task-links"
    >
      {rel.parent && (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="text-fg-faint">Part of</span>
          <span className={chip}>
            <Link
              {...linkTo(rel.parent.id)}
              title={rel.parent.title}
              className="flex min-w-0 items-center gap-1.5 text-fg-soft hover:text-fg"
            >
              <span className="font-mono">{rel.parent.id}</span>
              <span className="max-w-[220px] truncate text-fg-muted">{rel.parent.title}</span>
            </Link>
            <RemoveLink
              label={`Remove link to ${rel.parent.id}`}
              onClick={() =>
                setAsking({
                  task: task.id,
                  type: "parent",
                  target: rel.parent?.id ?? "",
                  label: `Stop ${task.id} being part of ${rel.parent?.id}?`,
                })
              }
            />
          </span>
        </span>
      )}
      {rel.depends.length > 0 && (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-fg-faint">Waits for</span>
          {rel.depends.map((d) => (
            <span key={d.id} className={chip}>
              <Link
                {...linkTo(d.id)}
                title={`${d.title ?? d.id} (until ${d.when === "ready" ? "ready to ship" : "done"})`}
                className={cn(
                  "flex items-center gap-1 font-mono hover:text-fg",
                  d.waiting ? "text-coral" : "text-fg-muted",
                )}
              >
                {!d.waiting && <Check aria-hidden="true" className="size-3 text-green" />}
                {d.id}
              </Link>
              <RemoveLink
                label={`Remove link to ${d.id}`}
                onClick={() =>
                  setAsking({
                    task: task.id,
                    type: "depends-on",
                    target: d.id,
                    label: `Stop ${task.id} waiting for ${d.id}?`,
                  })
                }
              />
            </span>
          ))}
        </span>
      )}
      {rel.children.length > 0 && (
        <Menu
          label="Subtasks"
          maxHeight={420}
          items={rel.children.map((c) => {
            const line = subtaskLine(c);
            const state = line.waitingOn.length > 0 ? `${line.text} ${line.waitingOn.join(", ")}` : line.text;
            return {
              label: `${c.id}  ${short(c.title)}  ·  ${state}`,
              checked: c.status === "done",
              onSelect: () => void navigate(linkTo(c.id)),
            };
          })}
          trigger={({ ref, ...props }) => (
            <button
              ref={ref}
              type="button"
              {...props}
              title="Open a subtask"
              className={cn(chip, "cursor-pointer text-fg-muted")}
            >
              <span className="text-fg-faint">Subtasks</span>
              <span className="tnum">
                {rel.progress
                  ? `${rel.progress.done} of ${rel.progress.total} done`
                  : `${rel.children.length}`}
              </span>
              {rel.progress && rel.progress.total > 0 && (
                <span className="w-10">
                  <UsageBar pct={(rel.progress.done / rel.progress.total) * 100} tone="green" height={3} />
                </span>
              )}
              <ChevronDown aria-hidden="true" className="size-3" />
            </button>
          )}
        />
      )}
      <Menu
        label="Link a task"
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
          <button
            ref={ref}
            {...props}
            type="button"
            aria-label="Link a task"
            className="flex h-6 cursor-pointer items-center gap-1 rounded-sm text-fg-faint hover:text-fg"
          >
            <Plus aria-hidden="true" className="size-3" />
            Link
          </button>
        )}
      />
      {unlink.error && (
        <p role="alert" className="text-red">
          {unlink.error.message}
        </p>
      )}
      {asking && (
        <ConfirmDialog
          title="Remove link"
          body={asking.label}
          confirmLabel="Remove link"
          busy={unlink.isPending}
          error={unlink.error?.message}
          onCancel={() => setAsking(null)}
          onConfirm={() =>
            unlink.mutate(
              { task: asking.task, type: asking.type, target: asking.target },
              { onSuccess: () => setAsking(null) },
            )
          }
        />
      )}
      {picking && <LinkPicker task={task} type={picking} onClose={() => setPicking(null)} />}
    </div>
  );
}

const short = (title: string) => (title.length > 60 ? `${title.slice(0, 59)}…` : title);

function RemoveLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Remove link"
      onClick={onClick}
      className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-xs text-fg-dim hover:text-fg"
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
              Ready to ship
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
