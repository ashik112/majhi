import type { OriginView, Task, TrailStep } from "@majhi/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FileText } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { badgeLetters, formatTokens } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useIncident } from "@/lib/incident-queries";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useTaskDetail, useTaskRow, useUpdateTask } from "@/lib/task-queries";
import { useUsageSummary } from "@/lib/usage-queries";
import { AppMark } from "../clients/app-mark";
import { AreaChips, areaNames } from "../tasks-ui/area-chips";
import type { OrgTag } from "../tasks-ui/project-names";
import { TrailStrip } from "../tasks-ui/trail-strip";
import { TypeChip } from "../tasks-ui/type-chip";
import { CostText } from "../usage/cost";
import { Brief } from "./brief";
import { Crumbs } from "./crumbs";
import { TaskAction } from "./task-action";
import { TaskLinks } from "./task-links";
import { TaskMenu } from "./task-menu";
import { useCrumbFit } from "./use-crumb-fit";

/** A task that has begun has had its brief read: it stays folded until the owner asks for it. */
const started = (task: Pick<Task, "status">) => task.status !== "inbox" && task.status !== "ready";

/**
 * The page's header in three rows. The crumbs line: back, id, status, then workspace, projects and
 * origin, the type and its areas, the cost and the main action. The title, with the Brief button. The
 * tabs, with the trail of what the task produced at their right. Everything the owner reads about
 * the task fits in about 120 px.
 */
export function TaskHeader({
  task,
  yourTurn,
  brief,
  tabs,
  cardAsks,
  onShowRoom,
}: {
  task: Task;
  yourTurn: boolean;
  /** The room's dock holds a card with the primary button, so the header's stays quiet. */
  cardAsks: boolean;
  /** What the owner wrote beyond the title. */
  brief: string;
  tabs: ReactNode;
  /** A trail step that lives in the room (the check, the merge) shows it. */
  onShowRoom: () => void;
}) {
  const orgs = useOrgs().data ?? [];
  const { org: filter } = useOrgFilter();
  const navigate = useNavigate();
  const org = orgs.find((o) => o.id === task.org);
  const prefix = task.id.slice(0, task.id.lastIndexOf("-"));
  const tag: OrgTag = {
    name: org?.name ?? "No workspace",
    letters: badgeLetters(org?.key ?? prefix),
    color: org?.color,
  };
  const row = useTaskRow(task.id);
  const detail = useTaskDetail(task.id).data;
  const origin: OriginView | undefined = detail?.origin ?? row?.origin;
  const trail: readonly TrailStep[] = detail?.trail ?? row?.trail ?? [];
  const incident = useIncident(task.id, task.typing?.type === "incident").data ?? undefined;
  const areas = useMemo(() => areaNames(detail?.areas), [detail?.areas]);
  const [briefOpen, setBriefOpen] = useState(() => !started(task));

  const line = useRef<HTMLDivElement>(null);
  const fit = useCrumbFit(
    line,
    [tag.name, task.repos.map((r) => r.project).join(), origin?.kind, areas.join()].join("|"),
  );
  const chips = (
    <span className="flex min-w-0 shrink-0 items-center gap-1.5">
      <TypeChip id={task.id} typing={task.typing} size="sm" />
      <AreaChips names={areas} max={3} />
    </span>
  );
  // A client's report names its chat, and the watch that fires for it shows beside the type.
  const incidentChips = (
    <>
      {origin?.kind === "client" && (
        <span className="inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border border-line px-1.5 text-xs text-fg-soft">
          {origin.app !== undefined && <AppMark app={origin.app} size={14} />}
          {`From ${origin.from ?? origin.name ?? "a client"}`}
        </span>
      )}
      {incident?.watch !== undefined && (
        <span
          title={incident.watch.firing ? "The watch is firing" : "The watch is green"}
          className="inline-flex h-5 min-w-0 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-amber-line bg-amber-wash px-1.5 text-xs text-amber"
        >
          {`Watch ${incident.watch.title}`}
        </span>
      )}
    </>
  );

  const openTask = useCallback(
    (id: string) => void navigate({ to: "/t/$taskId", params: { taskId: id }, search: orgSearch(filter) }),
    [navigate, filter],
  );

  return (
    <header className={cn("@container flex shrink-0 flex-col gap-0.5 rounded-2xl px-5 pt-2", GLASS)}>
      <div className="flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        <div ref={line} className="flex min-w-0 flex-1 basis-[16rem] items-center gap-1.5 overflow-hidden">
          <Link
            to="/"
            search={orgSearch(filter)}
            aria-label="Back to board"
            title="Back to board"
            className="-ml-1 grid size-6 shrink-0 place-items-center rounded-sm text-fg-muted hover:bg-raised hover:text-fg"
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
          </Link>
          <span className="shrink-0 font-mono whitespace-nowrap text-fg-muted">{task.id}</span>
          <StatusBadge
            status={task.status}
            pausedReason={task.pausedReason}
            pausedBy={task.pausedBy}
            yourTurn={yourTurn}
            className="mx-1 shrink-0"
          />
          <Crumbs
            task={task}
            org={tag}
            // A client report names its chat in the chip beside the title.
            origin={origin?.kind === "client" ? undefined : origin}
            fit={fit}
            filter={filter}
          />
          {fit === "full" && <span className="ml-2 flex">{chips}</span>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <TaskCost taskId={task.id} />
          <TaskAction task={task} yourTurn={yourTurn} cardAsks={cardAsks} />
          <TaskMenu task={task} />
        </div>
      </div>
      <div className="flex min-h-7 min-w-0 items-center gap-2.5">
        <EditableTitle task={task} />
        {fit !== "full" && chips}
        {incidentChips}
        {brief !== "" && (
          <button
            type="button"
            aria-pressed={briefOpen}
            title={briefOpen ? "Hide the brief" : "Show the brief"}
            onClick={() => setBriefOpen((v) => !v)}
            className={cn(
              "ml-auto inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-base text-fg-muted hover:bg-raised hover:text-fg",
              briefOpen && "bg-selected text-fg shadow-[inset_0_0_0_1px_var(--c-line-control)]",
            )}
          >
            <FileText aria-hidden="true" className="size-3.5" />
            Brief
          </button>
        )}
      </div>
      {brief !== "" && briefOpen && <Brief key={brief} text={brief} task={task} />}
      <div className="-mx-5 mt-1 flex min-w-0 flex-wrap items-end gap-x-2 border-t border-line px-3">
        {tabs}
        <TrailStrip steps={trail} variant="bar" actions={{ onOpenTask: openTask, onShowRoom }} />
        <div className="ml-auto flex min-h-9 min-w-0 items-center py-1">
          <TaskLinks task={task} compact={trail.length > 0} />
        </div>
      </div>
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
      <span className="hidden tabular-nums @[40rem]:inline">· {formatTokens(all.totalTokens)} tokens</span>
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
      <h1 className="min-w-0 shrink text-lg leading-snug font-semibold">
        <button
          type="button"
          title={`${task.title} (click to edit)`}
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
      className="h-8 w-full rounded-md border border-line-control bg-field px-2 text-lg font-semibold text-fg focus-visible:border-accent focus-visible:outline-none"
    />
  );
}
