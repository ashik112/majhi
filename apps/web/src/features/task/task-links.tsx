import type { Task } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { Check, MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Menu } from "@/components/ui/menu";
import { Modal } from "@/components/ui/modal";
import { StatusBadge } from "@/components/ui/status-badge";
import { UsageBar } from "@/components/ui/usage-bar";
import { cn } from "@/lib/cn";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useLinkTask, useTasks, useUnlinkTask } from "@/lib/task-queries";
import { TaskChips } from "../new-task/task-chips";
import { linkTargets, relations } from "./model";

type Picking = "parent" | "depends-on" | null;

type Unlinking = { task: string; type: "parent" | "depends-on"; target: string; label: string };

/** Subtasks shown before "Show all": the header is pinned, so it stays short. */
const SHOWN_CHILDREN = 2;

/** Parent, what the task waits on and its subtasks, one labeled line each, and a quiet way to link more. */
export function TaskLinks({ task }: { task: Task }) {
  const list = useTasks().data ?? [];
  const { org } = useOrgFilter();
  const unlink = useUnlinkTask();
  const [picking, setPicking] = useState<Picking>(null);
  const [asking, setAsking] = useState<Unlinking | null>(null);
  const [all, setAll] = useState(false);
  const rel = relations(task, list);
  const search = orgSearch(org);
  const byId = new Map(list.map((t) => [t.id, t]));
  const kids = all ? rel.children : rel.children.slice(0, SHOWN_CHILDREN);
  const openLink = "flex min-w-0 items-baseline gap-1.5 hover:text-fg";
  const linkTo = (id: string) => ({ to: "/t/$taskId" as const, params: { taskId: id }, search });

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="task-links">
      {(rel.parent || rel.depends.length > 0 || rel.children.length > 0) && (
        <dl className="m-0 grid max-w-[760px] grid-cols-[76px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2">
          {rel.parent && (
            <>
              <dt className="text-fg-faint">Part of</dt>
              <dd className="m-0 flex items-center gap-2">
                <Link {...linkTo(rel.parent.id)} className={cn(openLink, "text-fg-soft")}>
                  <span className="shrink-0 font-mono text-xs text-fg-muted">{rel.parent.id}</span>
                  <span className="truncate">{rel.parent.title}</span>
                </Link>
                <RowMenu
                  label={`Options for ${rel.parent.id}`}
                  onUnlink={() =>
                    setAsking({
                      task: task.id,
                      type: "parent",
                      target: rel.parent?.id ?? "",
                      label: `Stop ${task.id} being part of ${rel.parent?.id}?`,
                    })
                  }
                />
              </dd>
            </>
          )}
          {rel.depends.length > 0 && (
            <>
              <dt className="text-fg-faint">Waits for</dt>
              <dd className="m-0 flex min-w-0 flex-col gap-1">
                {rel.depends.map((d) => (
                  <span key={d.id} className="flex items-center gap-2">
                    <Link
                      {...linkTo(d.id)}
                      className={cn(openLink, d.waiting ? "text-coral" : "text-fg-faint")}
                    >
                      {!d.waiting && <Check aria-hidden="true" className="size-3 shrink-0 self-center" />}
                      <span className="shrink-0 font-mono text-xs">{d.id}</span>
                      <span className="truncate">{d.title}</span>
                      <span className="shrink-0 text-fg-faint">
                        · until {d.when === "ready" ? "ready for review" : "done"}
                      </span>
                    </Link>
                    <RowMenu
                      label={`Options for ${d.id}`}
                      onUnlink={() =>
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
              </dd>
            </>
          )}
          {rel.children.length > 0 && (
            <>
              <dt className="text-fg-faint">Subtasks</dt>
              <dd className="m-0 flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-3 text-fg-muted">
                  {rel.progress
                    ? `${rel.progress.done} of ${rel.progress.total} done`
                    : `${rel.children.length}`}
                  {rel.progress && rel.progress.total > 0 && (
                    <span className="w-28">
                      <UsageBar
                        pct={(rel.progress.done / rel.progress.total) * 100}
                        tone="green"
                        height={3}
                      />
                    </span>
                  )}
                </span>
                {/* Expanded, the list scrolls inside the header instead of pushing the room down. */}
                <span className={cn("flex flex-col gap-1.5", all && "max-h-40 overflow-y-auto pr-1")}>
                  {kids.map((c) => (
                    <span key={c.id} className="flex items-center gap-2">
                      <Link {...linkTo(c.id)} className={cn(openLink, "flex-1 text-fg-soft")}>
                        <span className="shrink-0 font-mono text-xs text-fg-muted">{c.id}</span>
                        <span className="truncate">{byId.get(c.id)?.title ?? c.title}</span>
                      </Link>
                      <StatusBadge status={c.status} />
                      <RowMenu
                        label={`Options for ${c.id}`}
                        onUnlink={() =>
                          setAsking({
                            task: c.id,
                            type: "parent",
                            target: task.id,
                            label: `Remove ${c.id} from ${task.id}?`,
                          })
                        }
                      />
                    </span>
                  ))}
                </span>
                {rel.children.length > SHOWN_CHILDREN && (
                  <button
                    type="button"
                    onClick={() => setAll((v) => !v)}
                    className="w-fit cursor-pointer rounded-xs text-fg-muted hover:text-fg"
                  >
                    {all ? "Show fewer" : `Show all ${rel.children.length}`}
                  </button>
                )}
              </dd>
            </>
          )}
        </dl>
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
            className="flex h-6 w-fit cursor-pointer items-center gap-1.5 rounded-sm text-fg-faint hover:text-fg"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            Link a task
          </button>
        )}
      />
      {unlink.error && (
        <p role="alert" className="text-sm text-red">
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

function RowMenu({ label, onUnlink }: { label: string; onUnlink: () => void }) {
  return (
    <Menu
      label={label}
      icon={<MoreHorizontal aria-hidden="true" className="size-3.5" />}
      items={[{ label: "Remove link", tone: "danger", onSelect: onUnlink }]}
    />
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
