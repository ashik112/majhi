import type { Task } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { OrgBadge } from "@/components/ui/org-badge";
import { TONE_CLASS } from "@/components/ui/status-badge";
import { cn } from "@/lib/cn";
import { badgeLetters } from "@/lib/format";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { statusInfo } from "../tasks/model";
import { TaskLinks } from "./task-links";
import { TaskMenu } from "./task-menu";

/** Back link, key and status, repos, and the title. */
export function TaskHeader({ task, yourTurn }: { task: Task; yourTurn: boolean }) {
  const orgs = useOrgs().data ?? [];
  const { org: filter } = useOrgFilter();
  const org = orgs.find((o) => o.id === task.org);
  const info = statusInfo(task.status, task.pausedReason, yourTurn);
  const prefix = task.id.slice(0, task.id.lastIndexOf("-"));
  const repos = task.repos.map((r) => r.project);

  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-line px-8 pt-3.5 pb-4">
      <Link
        to="/"
        search={orgSearch(filter)}
        className="-ml-1 flex h-7 w-fit items-center gap-1.5 rounded-sm px-1 text-base text-fg-muted transition-colors duration-150 hover:text-fg"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        Back to board
      </Link>
      <div className="flex items-center gap-3">
        <OrgBadge label={badgeLetters(org?.key ?? prefix)} color={org?.color} size="md" />
        <span className="font-mono text-sm text-fg-muted">{task.id}</span>
        <span
          className={cn(
            "rounded-full border border-line-control bg-raised px-2.5 py-1 text-sm leading-[1.25] whitespace-nowrap",
            TONE_CLASS[info.tone],
          )}
        >
          {info.label}
        </span>
        <span className="min-w-0 truncate text-sm text-fg-faint">
          {repos.length > 0 ? repos.join(" + ") : task.kind === "chat" ? "chat" : "no repo"}
        </span>
        <div className="ml-auto -my-1">
          <TaskMenu task={task} />
        </div>
      </div>
      <h1 className="text-xl leading-[1.25] font-semibold text-balance">{task.title}</h1>
      <TaskLinks task={task} />
    </header>
  );
}
