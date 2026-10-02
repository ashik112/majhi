import type { OrgView, TaskSummary } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { AvatarStack } from "@/components/ui/avatar-stack";
import { Badge } from "@/components/ui/badge";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { OrgBadge } from "@/components/ui/org-badge";
import { UsageBar } from "@/components/ui/usage-bar";
import { dueText, PRIORITY_WORD } from "@/features/autonomy/model";
import { cn } from "@/lib/cn";
import { badgeLetters } from "@/lib/format";
import { orgSearch } from "@/lib/org-filter";
import { prefetchTask } from "@/lib/task-queries";
import { taskLamp } from "../tasks/model";
import { cardLine, cardProgress, partOf, plainTitle } from "./model";

export function cardDomId(id: string): string {
  return `card-${id}`;
}

/** The two-letter tile and color of a task's org; tasks without an org get the task key's letters in grey. */
export function orgTile(task: Pick<TaskSummary, "id" | "org">, orgs: readonly OrgView[]) {
  const org = orgs.find((o) => o.id === task.org);
  const prefix = task.id.slice(0, task.id.lastIndexOf("-"));
  return { label: badgeLetters(org?.key ?? prefix), color: org?.color };
}

/** Lit cards carry their lamp in the frame: a tinted hairline and a faint wash from the top edge. */
const LIT = {
  working:
    "border-lamp-working/30 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--c-lamp-working)_7%,transparent),transparent_60%)]",
  needs:
    "border-lamp-needs/35 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--c-lamp-needs)_8%,transparent),transparent_60%)]",
  paused:
    "border-lamp-paused/30 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--c-lamp-paused)_7%,transparent),transparent_60%)]",
  done: "",
  idle: "",
} as const;

/**
 * One task on the board. The title is the link and covers the whole card, so the parent link can sit
 * on top of it. The frame holds the id and the keyboard focus target for j/k/h/l.
 */
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
  const lamp = taskLamp(task);
  const line = cardLine(task);
  const progress = cardProgress(task);
  const parent = partOf(task);
  const title = plainTitle(task.title);
  const tile = filterOrg === undefined ? orgTile(task, orgs) : undefined;
  const busy = lamp === "working";
  const repos = task.repos.map((r) => r.project).join(", ");

  return (
    <article
      id={cardDomId(task.id)}
      data-card=""
      onPointerEnter={() => prefetchTask(client, task.id)}
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
      className={cn(
        "group relative flex shrink-0 animate-rise flex-col gap-2 rounded-xl border border-glass-line bg-card p-3 text-base text-fg",
        "shadow-glass backdrop-blur-[12px]",
        "transition-[transform,border-color,box-shadow,background-color] duration-150 ease-out",
        "hover:-translate-y-px hover:border-line-hover hover:shadow-pop",
        "has-[a[data-card-link]:focus-visible]:outline-2 has-[a[data-card-link]:focus-visible]:outline-offset-2 has-[a[data-card-link]:focus-visible]:outline-accent",
        LIT[lamp],
      )}
    >
      <span className="flex h-5 min-w-0 items-center gap-2">
        <Lamp state={lamp} size={8} />
        {tile && <OrgBadge label={tile.label} color={tile.color} size="xs" />}
        <span className="shrink-0 font-mono text-xs text-fg-muted">{task.id}</span>
        {parent && (
          <Link
            to="/t/$taskId"
            params={{ taskId: parent }}
            search={orgSearch(filterOrg)}
            title={`Open the parent task ${parent}`}
            className="relative z-10 min-w-0 truncate rounded-xs font-mono text-xs text-fg-faint underline-offset-2 hover:text-fg hover:underline"
          >
            in {parent}
          </Link>
        )}
        {task.kind === "chat" && <span className="shrink-0 text-xs text-fg-faint">chat</span>}
        <AvatarStack ids={task.team} working={task.working} size={18} max={3} className="ml-auto shrink-0" />
      </span>
      <Link
        to="/t/$taskId"
        params={{ taskId: task.id }}
        search={orgSearch(filterOrg)}
        data-card-link=""
        onFocus={() => prefetchTask(client, task.id)}
        title={repos ? `${title} (${repos})` : title}
        className="line-clamp-3 text-body leading-[1.35] font-medium break-words outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
      >
        {title}
        {repos && <span className="sr-only">. Project: {repos}</span>}
      </Link>
      {line && (
        <span aria-live="polite" className={cn("truncate text-sm", LAMP_TEXT[line.lamp])}>
          {line.text}
        </span>
      )}
      <TaskChips task={task} />
      {progress ? (
        <span className="flex items-center gap-2">
          <UsageBar
            pct={progress.pct}
            tone={progress.pct >= 100 ? "done" : "calm"}
            height={3}
            className="flex-1"
          />
          <span className="tnum shrink-0 font-mono text-xs text-fg-muted">{progress.text}</span>
        </span>
      ) : (
        busy && (
          <span
            aria-hidden="true"
            className="relative block h-[3px] overflow-hidden rounded-full bg-line-strong"
          >
            <span className="absolute inset-y-0 left-0 w-1/3 animate-sweep rounded-full bg-[linear-gradient(90deg,transparent,var(--c-lamp-working),transparent)]" />
          </span>
        )
      )}
    </article>
  );
});

/** Autonomous mode runs it, and the owner's priority and deadline. Nothing shows for a normal task. */
function TaskChips({ task }: { task: Pick<TaskSummary, "autonomous" | "priority" | "due" | "status"> }) {
  const now = Date.now();
  const due = task.due !== undefined && task.status !== "done" ? dueText(task.due, now) : undefined;
  const priority = task.priority !== undefined && task.priority !== "normal" ? task.priority : undefined;
  if (!task.autonomous && priority === undefined && due === undefined) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {task.autonomous && (
        <Badge title="Autonomous mode runs this task" className="h-[18px]">
          Auto
        </Badge>
      )}
      {priority && (
        <Badge tone={priority === "high" ? "amber" : "neutral"} className="h-[18px]">
          {PRIORITY_WORD[priority]} priority
        </Badge>
      )}
      {due && (
        <Badge tone={due.late ? "red" : due.soon ? "amber" : "neutral"} className="h-[18px]">
          {due.text}
        </Badge>
      )}
    </span>
  );
}
