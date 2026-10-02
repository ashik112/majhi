import type { Task, TaskSummary } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { useToast } from "@/components/ui/toast";
import { UsageBar } from "@/components/ui/usage-bar";
import { cn } from "@/lib/cn";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useStartTask, useTasks } from "@/lib/task-queries";
import { canStartSubtask, relations, subtaskLine } from "./model";

/** The card's id, so the header's summary can bring it into view. */
export const SUBTASKS_CARD_ID = "subtasks-card";

/** Brings the Subtasks card into view and moves focus to it. */
export function showSubtasksCard(): void {
  const card = document.getElementById(SUBTASKS_CARD_ID);
  if (!card) return;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  card.focus({ preventScroll: true });
}

/**
 * A parent task's subtasks, each with its lamp and state, what it waits for, and Start when it can
 * start now. Follows the task list, so it changes as the subtasks move. Hidden without subtasks.
 */
export function SubtasksCard({ task }: { task: Task }) {
  const list = useTasks().data ?? [];
  const rel = relations(task, list);
  if (rel.children.length === 0) return null;
  const progress = rel.progress ?? { done: 0, total: rel.children.length };
  return (
    <Card
      id={SUBTASKS_CARD_ID}
      tabIndex={-1}
      aria-labelledby="subtasks-heading"
      className="shrink-0 gap-0 px-0 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex items-center gap-2 px-3 pb-1.5">
        <h2 id="subtasks-heading" className="text-sm font-semibold">
          Subtasks
        </h2>
        <span className="tnum text-xs text-fg-faint">
          <span className="font-mono text-fg-muted">{progress.done}</span> of{" "}
          <span className="font-mono text-fg-muted">{progress.total}</span> done
        </span>
        {progress.total > 0 && (
          <span className="ml-auto w-14">
            <UsageBar pct={(progress.done / progress.total) * 100} tone="green" height={3} />
          </span>
        )}
      </div>
      <ul className="m-0 flex max-h-[min(360px,45dvh)] list-none flex-col overflow-y-auto overscroll-contain p-0 px-3 scroll-fade">
        {rel.children.map((child, i) => (
          <SubtaskRow key={child.id} task={child} first={i === 0} />
        ))}
      </ul>
    </Card>
  );
}

function SubtaskRow({ task, first }: { task: TaskSummary; first: boolean }) {
  const { org } = useOrgFilter();
  const start = useStartTask();
  const toast = useToast();
  const line = subtaskLine(task);
  const search = orgSearch(org);
  const done = task.status === "done";
  return (
    <li className={cn("flex items-start gap-2 py-2", !first && "border-t border-line")}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link
          to="/t/$taskId"
          params={{ taskId: task.id }}
          search={search}
          title={`${task.id} ${task.title}`}
          className="group flex min-w-0 flex-col gap-0.5 rounded-xs text-left"
        >
          <span className="font-mono text-xs text-fg-faint group-hover:text-fg-muted">{task.id}</span>
          <span
            className={cn(
              "line-clamp-2 text-base leading-snug [overflow-wrap:anywhere] group-hover:text-fg",
              done ? "text-fg-muted" : "text-fg-soft",
            )}
          >
            {task.title}
          </span>
        </Link>
        <span className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm", LAMP_TEXT[line.lamp])}>
          <Lamp state={line.lamp} size={7} />
          <span>{line.text}</span>
          {line.waitingOn.map((id, i) => (
            <span key={id}>
              <Link
                to="/t/$taskId"
                params={{ taskId: id }}
                search={search}
                className="font-mono text-xs text-fg-muted hover:text-fg"
              >
                {id}
              </Link>
              {i < line.waitingOn.length - 1 && ","}
            </span>
          ))}
        </span>
      </div>
      {canStartSubtask(task) && (
        <Button
          size="sm"
          className="mt-3 shrink-0"
          title={`Start ${task.id}`}
          aria-label={`Start ${task.id}`}
          disabled={start.isPending}
          onClick={() =>
            start.mutate(task.id, {
              onError: (e) => toast(`Could not start ${task.id}`, { detail: e.message, tone: "error" }),
            })
          }
        >
          <Play aria-hidden="true" />
          Start
        </Button>
      )}
    </li>
  );
}
