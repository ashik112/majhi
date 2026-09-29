import type { OrgView, TaskSummary } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { memo } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { TONE_CLASS } from "@/components/ui/status-badge";
import { cn } from "@/lib/cn";
import type { TaskGroupView } from "./model";
import { GROUP_LABEL, type GroupId, orgColor, repoLabel, statusInfo } from "./model";

const GROUP_TONE: Record<GroupId, string> = {
  "needs-you": "text-amber",
  working: "text-blue",
  "up-next": "text-fg-muted",
  done: "text-fg-faint",
};

export function rowDomId(id: string): string {
  return `task-row-${id}`;
}

/** Tasks in four groups: Needs you, Working, Up next, and Done, which starts collapsed. */
export function TaskList({
  groups,
  orgs,
  openId,
  cursorId,
  doneOpen,
  onToggleDone,
}: {
  groups: readonly TaskGroupView[];
  orgs: readonly OrgView[];
  openId: string | undefined;
  cursorId: string | undefined;
  doneOpen: boolean;
  onToggleDone: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pt-1 pb-4">
      {groups.map((group) => {
        const collapsed = group.id === "done" && !doneOpen;
        return (
          <section key={group.id} aria-label={group.label}>
            <div className="flex items-center gap-2 px-2 pt-3 pb-1">
              {group.id === "done" ? (
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={onToggleDone}
                  className="flex items-center gap-1.5 rounded-xs text-xs font-semibold tracking-[0.08em] text-fg-faint uppercase hover:text-fg-muted"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn("size-3 transition-transform", !collapsed && "rotate-90")}
                  />
                  {GROUP_LABEL.done}
                </button>
              ) : (
                <h2 className={cn("text-xs font-semibold tracking-[0.08em] uppercase", GROUP_TONE[group.id])}>
                  {group.label}
                </h2>
              )}
              <span className="font-mono text-xs text-fg-faint">{group.tasks.length}</span>
            </div>
            {!collapsed && (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    color={orgColor(orgs, task.org)}
                    open={task.id === openId}
                    cursor={task.id === cursorId}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

const TaskRow = memo(function TaskRow({
  task,
  color,
  open,
  cursor,
}: {
  task: TaskSummary;
  color: string | undefined;
  open: boolean;
  cursor: boolean;
}) {
  const info = statusInfo(task.status, task.pausedReason);
  const agent = task.team[0];
  return (
    <li>
      <Link
        to="/t/$taskId"
        params={{ taskId: task.id }}
        id={rowDomId(task.id)}
        aria-current={open ? "page" : undefined}
        data-task-row=""
        className={cn(
          "flex flex-col gap-1.5 rounded-lg border px-2.5 py-2.5 transition-colors duration-75 hover:bg-card",
          open ? "border-line-control bg-selected" : "border-transparent",
          cursor && !open && "border-line-strong bg-card",
        )}
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-xs bg-fg-faint"
            style={color ? { backgroundColor: color } : undefined}
          />
          <span className="font-mono text-xs text-fg-muted">{task.id}</span>
          <span className={cn("ml-auto text-xs", TONE_CLASS[info.tone])}>{info.label}</span>
        </span>
        <span className="text-base leading-[1.35] font-medium text-fg">{task.title}</span>
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate font-mono text-xs text-fg-faint">{repoLabel(task.repos)}</span>
          {agent && (
            <span className="ml-auto flex">
              <AgentAvatar id={agent} size={18} working={task.working.includes(agent)} />
            </span>
          )}
        </span>
      </Link>
    </li>
  );
});
