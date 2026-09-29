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
import { TaskAction } from "./task-action";
import { TaskLinks } from "./task-links";
import { TaskMenu } from "./task-menu";

/** One line with the back link, key, status, project, org and the main action; the title; the links. */
export function TaskHeader({ task, yourTurn }: { task: Task; yourTurn: boolean }) {
  const orgs = useOrgs().data ?? [];
  const { org: filter } = useOrgFilter();
  const org = orgs.find((o) => o.id === task.org);
  const info = statusInfo(task.status, task.pausedReason, yourTurn);
  const prefix = task.id.slice(0, task.id.lastIndexOf("-"));
  const repos = task.repos.map((r) => r.project);

  return (
    <header className="flex shrink-0 flex-col gap-1 border-b border-line px-5 pt-2 pb-2.5">
      <div className="flex min-h-8 items-center gap-2.5 text-sm">
        <Link
          to="/"
          search={orgSearch(filter)}
          aria-label="Back to board"
          title="Back to board"
          className="-ml-1 grid size-6 shrink-0 place-items-center rounded-sm text-fg-muted hover:bg-raised hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
        </Link>
        <span className="font-mono text-fg-muted">{task.id}</span>
        <span
          className={cn(
            "rounded-full border border-line-control px-2 py-px text-xs whitespace-nowrap",
            TONE_CLASS[info.tone],
          )}
        >
          {info.label}
        </span>
        {repos.length > 0 ? (
          <span
            title={`Project: ${repos.join(", ")}`}
            className="flex min-w-0 items-center gap-1 font-mono text-xs text-fg-soft"
          >
            <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-fg-faint" />
            <span className="truncate">{repos.join(" + ")}</span>
          </span>
        ) : (
          <span className="text-xs text-fg-faint">{task.kind === "chat" ? "chat" : "no project"}</span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          <OrgBadge label={badgeLetters(org?.key ?? prefix)} color={org?.color} size="sm" />
          <span className="truncate">{org?.name ?? "No org"}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <TaskCost taskId={task.id} />
          <TaskAction task={task} yourTurn={yourTurn} />
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
    <span className="mr-2 flex items-baseline gap-1 text-sm text-fg-muted whitespace-nowrap">
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
      <h1 className="text-lg leading-snug font-semibold">
        <button
          type="button"
          title={`${task.title} (click to edit)`}
          onClick={() => setDraft(task.title)}
          className="line-clamp-1 cursor-text rounded-xs text-left hover:bg-raised"
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
      className="h-8 w-full rounded-md border border-line-control bg-field px-2 text-lg font-semibold text-fg focus-visible:border-blue focus-visible:outline-none"
    />
  );
}
