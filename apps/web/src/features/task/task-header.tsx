import type { Task } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useState } from "react";
import { OrgBadge } from "@/components/ui/org-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { badgeLetters } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useUpdateTask } from "@/lib/task-queries";
import { TypeChip } from "../tasks-ui/type-chip";
import { TaskAction } from "./task-action";
import { TaskMenu } from "./task-menu";

/**
 * The page's header, one row. Left: back, the workspace badge, the title (click to edit) and the status.
 * Middle: the tabs. Right: the incident chip, the one action (Start, Resume or Stop) and the menu.
 * Everything else about the task is in the side panel or in the Brief tab.
 */
export function TaskHeader({
  task,
  yourTurn,
  tabs,
  cardAsks,
  shipAsk,
  onDetails,
}: {
  task: Task;
  yourTurn: boolean;
  /** The room's dock holds a card with the primary button, so the header's stays quiet. */
  cardAsks: boolean;
  tabs: ReactNode;
  /** Counts up each time a step asks for the Ship panel. */
  shipAsk: number;
  /** Where the side panel is not beside the page: the menu's Details opens it over the page. */
  onDetails?: (() => void) | undefined;
}) {
  const orgs = useOrgs().data ?? [];
  const { org: filter } = useOrgFilter();
  const org = orgs.find((o) => o.id === task.org);
  const prefix = task.id.slice(0, task.id.lastIndexOf("-"));
  const name = org?.name ?? "No workspace";
  return (
    <header className={cn("flex min-h-12 shrink-0 items-center gap-3 rounded-2xl px-3.5 py-1.5", GLASS)}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Link
          to="/"
          search={orgSearch(filter)}
          aria-label="Back to Home"
          title="Back to Home"
          className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-raised hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Link>
        <span title={name} className="flex shrink-0">
          <OrgBadge label={badgeLetters(org?.key ?? prefix)} color={org?.color} size="md" />
          <span className="sr-only">{name}</span>
        </span>
        <EditableTitle task={task} />
        <StatusBadge
          status={task.status}
          pausedReason={task.pausedReason}
          pausedBy={task.pausedBy}
          yourTurn={yourTurn}
          className="shrink-0"
        />
      </div>
      {tabs}
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        {task.typing?.type === "incident" && <TypeChip id={task.id} typing={task.typing} size="sm" />}
        <TaskAction task={task} yourTurn={yourTurn} cardAsks={cardAsks} shipAsk={shipAsk} />
        <TaskMenu task={task} onDetails={onDetails} />
      </div>
    </header>
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
      <h1 className="min-w-0 shrink text-md leading-snug font-semibold">
        <button
          type="button"
          title={`${task.id}: ${task.title} (click to edit)`}
          onClick={() => setDraft(task.title)}
          className="block max-w-full cursor-text truncate rounded-xs text-left hover:bg-raised"
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
      className="h-8 min-w-0 flex-1 rounded-md border border-line-control bg-field px-2 text-md font-semibold text-fg focus-visible:border-accent focus-visible:outline-none"
    />
  );
}
