import type { OrgView, TaskSummary } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { AvatarStack } from "@/components/ui/avatar-stack";
import { OrgBadge } from "@/components/ui/org-badge";
import { UsageBar } from "@/components/ui/usage-bar";
import { cn } from "@/lib/cn";
import { badgeLetters } from "@/lib/format";
import { orgSearch } from "@/lib/org-filter";
import { prefetchTask } from "@/lib/task-queries";
import { type CardNote, cardNote, cardProgress, type NoteTone, partOf } from "./model";

export function cardDomId(id: string): string {
  return `card-${id}`;
}

const NOTE_TONE: Record<NoteTone, string> = {
  amber: "text-amber",
  violet: "text-violet",
  coral: "text-coral",
};

/** The two-letter tile and color of a task's org; tasks without an org get the task key's letters in grey. */
export function orgTile(task: Pick<TaskSummary, "id" | "org">, orgs: readonly OrgView[]) {
  const org = orgs.find((o) => o.id === task.org);
  const prefix = task.id.slice(0, task.id.lastIndexOf("-"));
  return { label: badgeLetters(org?.key ?? prefix), color: org?.color };
}

export const BoardCard = memo(function BoardCard({
  task,
  orgs,
  filterOrg,
  index,
}: {
  task: TaskSummary;
  orgs: readonly OrgView[];
  filterOrg: string | undefined;
  index: number;
}) {
  const client = useQueryClient();
  const tile = orgTile(task, orgs);
  const note: CardNote | null = cardNote(task);
  const progress = cardProgress(task);
  const parent = partOf(task);
  return (
    <Link
      to="/t/$taskId"
      params={{ taskId: task.id }}
      search={orgSearch(filterOrg)}
      id={cardDomId(task.id)}
      data-card=""
      onPointerEnter={() => prefetchTask(client, task.id)}
      onFocus={() => prefetchTask(client, task.id)}
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
      className={cn(
        "flex animate-rise flex-col gap-2.5 rounded-lg border bg-raised p-3 text-base text-fg",
        "transition-[transform,border-color,box-shadow] duration-150 ease-out",
        "hover:-translate-y-px hover:border-line-hover hover:shadow-[0_6px_18px_-8px_rgb(0_0_0/0.6)]",
        "active:translate-y-0 active:shadow-none",
        task.status === "paused" ? "border-red-line" : "border-line-strong",
      )}
    >
      <span className="flex items-center gap-2">
        <OrgBadge label={tile.label} color={tile.color} size="sm" />
        <span className="min-w-0 truncate font-mono text-xs text-fg-muted">
          {task.id}
          {task.kind === "chat" && <span className="text-fg-faint"> · chat</span>}
        </span>
      </span>
      {parent && <span className="-mt-1 truncate font-mono text-xs text-fg-faint">Part of {parent}</span>}
      <span title={task.title} className="line-clamp-3 text-body leading-[1.35] font-medium break-words">
        {task.title}
      </span>
      {(task.repos.length > 0 || task.team.length > 0) && (
        <span className="flex flex-wrap items-center gap-1.5">
          {task.repos.map((repo) => (
            <span
              key={repo.project}
              className="rounded-[5px] bg-selected px-[7px] py-[3px] font-mono text-xs leading-[14px] text-fg-soft"
            >
              {repo.project}
            </span>
          ))}
          <AvatarStack ids={task.team} working={task.working} />
        </span>
      )}
      {progress && (
        <span className="flex flex-col gap-1.5">
          <span className="text-sm text-fg-muted">{progress.text}</span>
          <UsageBar pct={progress.pct} tone="green" height={3} />
        </span>
      )}
      {note && <span className={cn("text-sm", NOTE_TONE[note.tone])}>{note.text}</span>}
    </Link>
  );
});
