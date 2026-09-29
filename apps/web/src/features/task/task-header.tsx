import type { Task } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, FolderGit2 } from "lucide-react";
import { useState } from "react";
import { OrgBadge } from "@/components/ui/org-badge";
import { TONE_CLASS } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { badgeLetters, formatTokens } from "@/lib/format";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useUpdateTask } from "@/lib/task-queries";
import { useUsageSummary } from "@/lib/usage-queries";
import { statusInfo } from "../tasks/model";
import { CostText } from "../usage/cost";
import { TaskLinks } from "./task-links";
import { TaskMenu } from "./task-menu";

/** Back link, key, status, project and org; the title; then how the task relates to others. */
export function TaskHeader({ task, yourTurn }: { task: Task; yourTurn: boolean }) {
  const orgs = useOrgs().data ?? [];
  const { org: filter } = useOrgFilter();
  const org = orgs.find((o) => o.id === task.org);
  const info = statusInfo(task.status, task.pausedReason, yourTurn);
  const prefix = task.id.slice(0, task.id.lastIndexOf("-"));
  const repos = task.repos.map((r) => r.project);

  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-line px-8 pt-3.5 pb-4">
      <div className="flex items-center gap-3">
        <Link
          to="/"
          search={orgSearch(filter)}
          className="-ml-1 flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-1 text-base text-fg-muted transition-colors duration-150 hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Board
        </Link>
        <span aria-hidden="true" className="h-4 w-px bg-line-strong" />
        <span className="font-mono text-sm text-fg-muted">{task.id}</span>
        <span
          className={cn(
            "rounded-full border border-line-control bg-raised px-2.5 py-1 text-sm leading-[1.25] whitespace-nowrap",
            TONE_CLASS[info.tone],
          )}
        >
          {info.label}
        </span>
        {repos.length > 0 ? (
          <span
            title={`Project: ${repos.join(", ")}`}
            className="flex min-w-0 items-center gap-1.5 rounded-[5px] bg-selected px-2 py-1 font-mono text-xs text-fg-soft"
          >
            <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
            <span className="truncate">{repos.join(" + ")}</span>
          </span>
        ) : (
          <span className="text-sm text-fg-faint">{task.kind === "chat" ? "chat" : "no project"}</span>
        )}
        <span className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
          <OrgBadge label={badgeLetters(org?.key ?? prefix)} color={org?.color} size="sm" />
          <span className="truncate">{org?.name ?? "No org"}</span>
        </span>
        <div className="-my-1 ml-auto flex items-center gap-3">
          <TaskCost taskId={task.id} />
          <TaskMenu task={task} />
        </div>
      </div>
      <EditableTitle task={task} />
      <TaskLinks task={task} />
    </header>
  );
}

/** What the task has cost so far, all turns of every agent. Hidden until the first turn. */
function TaskCost({ taskId }: { taskId: string }) {
  const summary = useUsageSummary({ task: taskId });
  const all = summary.data?.all;
  if (!all || all.turns === 0 || summary.isPlaceholderData) return null;
  return (
    <span className="flex items-baseline gap-1 text-sm text-fg-muted whitespace-nowrap">
      <span className="sr-only">Cost so far: </span>
      <CostText totals={all} className="text-fg-soft" />
      <span className="tabular-nums">· {formatTokens(all.totalTokens)} tokens</span>
    </span>
  );
}

/** The title. Click to edit it; Enter saves, Esc cancels. */
function EditableTitle({ task }: { task: Task }) {
  const update = useUpdateTask();
  const toast = useToast();
  const [draft, setDraft] = useState<string>();

  function save() {
    const title = draft?.trim();
    setDraft(undefined);
    if (title === undefined || title === "" || title === task.title) return;
    update.mutate(
      { id: task.id, title },
      { onError: (e) => toast("Could not rename the task", { detail: e.message, tone: "error" }) },
    );
  }

  if (draft === undefined) {
    return (
      <h1 className="text-xl leading-[1.25] font-semibold text-balance">
        <button
          type="button"
          title={`${task.title} (click to edit)`}
          onClick={() => setDraft(task.title)}
          className="line-clamp-2 cursor-text rounded-xs text-left hover:bg-raised"
        >
          {task.title}
        </button>
      </h1>
    );
  }
  return (
    <input
      aria-label="Task title"
      // biome-ignore lint/a11y/noAutofocus: the owner just asked to edit it
      autoFocus
      value={draft}
      maxLength={300}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") setDraft(undefined);
      }}
      className="h-9 w-full rounded-md border border-line-control bg-field px-2 text-xl font-semibold text-fg focus-visible:border-blue focus-visible:outline-none"
    />
  );
}
