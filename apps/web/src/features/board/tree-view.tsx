import type { OrgView } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { AvatarStack } from "@/components/ui/avatar-stack";
import { OrgBadge } from "@/components/ui/org-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/cn";
import { orgSearch } from "@/lib/org-filter";
import { orgTile } from "./board-card";
import { buildTree, type Column, cardProgress, visibleRows, waitingText } from "./model";

/** Every task as a row, children nested under their parent. One scroll area; up, down and enter work. */
export function TreeView({
  columns,
  orgs,
  filterOrg,
  empty,
}: {
  columns: readonly Column[];
  orgs: readonly OrgView[];
  filterOrg: string | undefined;
  empty: string;
}) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => visibleRows(buildTree(columns), collapsed), [columns, collapsed]);

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-row]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
      items[next]?.focus();
    }
  }

  if (rows.length === 0) {
    return <p className="p-8 text-base text-fg-faint">{empty}</p>;
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the arrow keys move between the rows inside
    <div onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto px-8 py-4">
      <ul aria-label="Tasks" className="mx-auto flex max-w-[1100px] flex-col">
        {rows.map(({ task, depth, hasChildren }) => {
          const tile = orgTile(task, orgs);
          const progress = cardProgress(task);
          const waiting = task.waitingOn.length > 0 && (task.status === "inbox" || task.status === "ready");
          const open = () =>
            navigate({ to: "/t/$taskId", params: { taskId: task.id }, search: orgSearch(filterOrg) });
          return (
            <li key={task.id} className="flex items-center" style={{ paddingLeft: depth * 24 }}>
              {hasChildren ? (
                <button
                  type="button"
                  aria-label={collapsed.has(task.id) ? `Expand ${task.id}` : `Collapse ${task.id}`}
                  aria-expanded={!collapsed.has(task.id)}
                  onClick={() => toggle(task.id)}
                  className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-faint hover:bg-raised hover:text-fg"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn("size-3.5 transition-transform", !collapsed.has(task.id) && "rotate-90")}
                  />
                </button>
              ) : (
                <span aria-hidden="true" className="size-7 shrink-0" />
              )}
              <button
                type="button"
                data-row=""
                onClick={open}
                title={task.title}
                className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-2 text-left text-base hover:bg-raised focus-visible:bg-raised"
              >
                <OrgBadge label={tile.label} color={tile.color} size="sm" />
                <span className="w-24 shrink-0 truncate font-mono text-xs text-fg-muted">{task.id}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
                {task.repos.slice(0, 1).map((repo) => (
                  <span
                    key={repo.project}
                    className="shrink-0 rounded-[5px] bg-selected px-[7px] py-[3px] font-mono text-xs leading-[14px] text-fg-soft"
                  >
                    {repo.project}
                  </span>
                ))}
                <span className="w-40 shrink-0 truncate text-right text-sm text-fg-muted">
                  {waiting ? (
                    <span className="text-fg-faint">{waitingText(task.waitingOn)}</span>
                  ) : (
                    progress?.text
                  )}
                </span>
                <AvatarStack ids={task.team} working={task.working} size={20} max={3} className="shrink-0" />
                <span className="flex w-32 shrink-0 justify-end">
                  <StatusBadge status={task.status} pausedReason={task.pausedReason} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
