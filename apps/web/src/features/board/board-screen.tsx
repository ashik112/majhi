import type { OrgView } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronsRight, ListChecks, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { BoardMatches } from "@/features/search/board-matches";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useOrgFilter } from "@/lib/org-filter";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import { useProjects, useTasks } from "@/lib/task-queries";
import { useUsageSummary } from "@/lib/usage-queries";
import { useNewTask } from "../new-task/new-task-context";
import { BoardCard, cardDomId } from "./board-card";
import {
  type BoardCounts,
  boardCounts,
  buildColumns,
  COLUMN_LAMP,
  type Column,
  directionOf,
  isBossChat,
  moveFocus,
} from "./model";
import { Roster } from "./roster";
import { TreeView } from "./tree-view";

/** Keys the board answers while focus is on a card or on the page itself, not in a field or dialog. */
function boardKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return false;
  return target.closest("dialog, [role='menu']") === null;
}

/** A column shows its cards when it has any; Done only when the owner opens it. The rest are rails. */
function isOpenColumn(column: Column, showDone: boolean): boolean {
  if (column.id === "done") return showDone && column.tasks.length > 0;
  return column.tasks.length > 0;
}

export function BoardScreen() {
  const tasks = useTasks();
  const orgs = useOrgs().data ?? [];
  const projects = useProjects();
  const { org } = useOrgFilter();
  const newTask = useNewTask();
  const tree = useSearch({ strict: false }).view === "tree";
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);

  const bossId = useAgents().data?.flatMap((a) =>
    a.status === "ok" && a.isBoss ? [a.agent.frontmatter.id] : [],
  )[0];
  const all = useMemo(() => (tasks.data ?? []).filter((t) => !isBossChat(t, bossId)), [tasks.data, bossId]);
  const columns = useMemo(() => buildColumns(all, { org, query }), [all, org, query]);
  const treeColumns = useMemo(
    () => (showDone ? columns : columns.filter((c) => c.id !== "done")),
    [columns, showDone],
  );
  const counts = boardCounts(all, org);
  const onlyIds = useMemo(
    () => columns.map((c) => (isOpenColumn(c, showDone) ? c.tasks.map((t) => t.id) : [])),
    [columns, showDone],
  );

  // j k h l and the arrows move focus over the cards; the page itself listens, so they work before a card has focus.
  const grid = useRef(onlyIds);
  grid.current = onlyIds;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const direction = directionOf(event.key);
      if (!direction || !boardKeyTarget(event.target)) return;
      const current =
        event.target instanceof HTMLElement ? event.target.closest("[data-card]")?.id : undefined;
      const next = moveFocus(grid.current, current?.replace(/^card-/, ""), direction);
      if (!next) return;
      event.preventDefault();
      const card = document.getElementById(cardDomId(next));
      card?.querySelector<HTMLElement>("a[data-card-link]")?.focus();
      card?.scrollIntoView({ block: "nearest" });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const empty = tasks.isSuccess && all.length === 0;
  const noProjects = projects.isSuccess && projects.data.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <header
        className={cn(
          "flex min-h-[68px] shrink-0 items-center gap-4 rounded-2xl min-[1280px]:gap-5 py-3 pr-3 pl-5",
          GLASS,
        )}
      >
        <h1 className="text-xl leading-[26px] font-semibold tracking-[-0.01em]">Board</h1>
        <Telemetry counts={counts} org={org} />
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          {tree && counts.done > 0 && (
            <button
              type="button"
              aria-pressed={showDone}
              onClick={() => setShowDone((v) => !v)}
              className={cn(
                "tnum h-8 cursor-pointer rounded-md border px-2.5 text-sm transition-colors duration-150",
                showDone
                  ? "border-line-control bg-selected text-fg"
                  : "border-line-strong text-fg-muted hover:bg-raised hover:text-fg",
              )}
            >
              {showDone ? "Hide done" : "Show done"}
              <span className="ml-1.5 font-mono text-fg-faint">{counts.done}</span>
            </button>
          )}
          <Segmented
            label="Board layout"
            value={tree ? "tree" : "board"}
            onChange={(value) =>
              navigate({
                to: ".",
                search: (prev: object) => {
                  const { view: _view, ...rest } = prev as { view?: string };
                  return value === "tree" ? { ...rest, view: "tree" } : rest;
                },
              })
            }
            segments={[
              { value: "board", label: "Board" },
              { value: "tree", label: "Tree" },
            ]}
          />
          <label htmlFor="task-search" className="sr-only">
            Search tasks, messages and tool output
          </label>
          <span className="relative flex items-center">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 size-3.5 text-fg-faint"
            />
            <input
              id="task-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tasks and messages"
              autoComplete="off"
              spellCheck={false}
              title="Search tasks, messages and tool output"
              // Below 1280 px the field is an icon until it has focus or text, so the telemetry keeps its room.
              className={cn(
                "h-10 cursor-pointer rounded-md border border-line-strong bg-field pr-3 pl-8 text-base text-fg transition-[border-color,width] duration-200 hover:border-line-hover focus:w-[200px] focus:cursor-text focus:border-accent focus:outline-none",
                "min-[1280px]:w-[180px] min-[1280px]:cursor-text min-[1280px]:focus:w-[220px]",
                query === ""
                  ? "w-10 placeholder:text-transparent focus:placeholder:text-fg-faint min-[1280px]:placeholder:text-fg-faint"
                  : "w-[200px]",
              )}
            />
          </span>
          <Button
            variant="primary"
            size="lg"
            onClick={newTask.open}
            title="New task (n)"
            className="px-3.5 font-semibold"
          >
            <Plus aria-hidden="true" strokeWidth={2.5} />
            New task
          </Button>
        </div>
      </header>

      <BoardMatches query={query} org={org} />

      {tasks.isPending ? (
        <BoardSkeleton />
      ) : tasks.isError ? (
        <p role="alert" className={cn("rounded-2xl p-6 text-base text-red", GLASS)}>
          Could not load tasks. {tasks.error.message}
        </p>
      ) : empty ? (
        <EmptyBoard onNew={newTask.open} noProjects={noProjects} />
      ) : tree ? (
        <div className={cn("flex min-h-0 flex-1 flex-col rounded-2xl", GLASS)}>
          <TreeView
            columns={treeColumns}
            orgs={orgs}
            filterOrg={org}
            empty={query ? "No task matches." : "No open tasks."}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="flex min-w-0 flex-1 gap-3 overflow-x-auto">
            {columns.map((column) =>
              isOpenColumn(column, showDone) ? (
                <BoardColumn
                  key={column.id}
                  column={column}
                  orgs={orgs}
                  filterOrg={org}
                  onHide={column.id === "done" ? () => setShowDone(false) : undefined}
                />
              ) : (
                <ColumnRail
                  key={column.id}
                  column={column}
                  searching={query.trim() !== ""}
                  onOpen={
                    column.id === "done" && column.tasks.length > 0 ? () => setShowDone(true) : undefined
                  }
                />
              ),
            )}
          </div>
          <Roster tasks={all} org={org} />
        </div>
      )}
    </div>
  );
}

/** The readouts next to the title: open, working, waiting for the owner, and tokens used today. */
function Telemetry({ counts, org }: { counts: BoardCounts; org: string | undefined }) {
  const usage = useUsageSummary(org ? { org } : {});
  const today = usage.data?.today;
  return (
    <p className="flex min-w-0 items-center gap-3 overflow-hidden text-sm min-[1280px]:gap-4 whitespace-nowrap text-fg-muted">
      <span className="tnum">
        <span className="font-mono text-md font-medium text-fg">{counts.open}</span> open
      </span>
      <Divider />
      <span className="tnum flex items-center gap-1.5">
        <Lamp state="working" dim={counts.working === 0} size={7} />
        <span
          className={cn("font-mono text-md font-medium", counts.working > 0 ? LAMP_TEXT.working : "text-fg")}
        >
          {counts.working}
        </span>
        working
      </span>
      <Divider />
      <span className="tnum flex items-center gap-1.5">
        <Lamp state="needs" dim={counts.needs === 0} size={7} />
        <span className={cn("font-mono text-md font-medium", counts.needs > 0 ? LAMP_TEXT.needs : "text-fg")}>
          {counts.needs}
        </span>
        {counts.needs === 1 ? "needs you" : "need you"}
      </span>
      {today && (
        <>
          <Divider />
          <span className="tnum" title={`${today.totalTokens.toLocaleString()} tokens today`}>
            <span className="font-mono text-md font-medium text-fg">{formatTokens(today.totalTokens)}</span>{" "}
            tokens today
          </span>
        </>
      )}
    </p>
  );
}

function Divider({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("h-4 w-px shrink-0 bg-line-strong", className)} />;
}

function ColumnHead({ column, onHide }: { column: Column; onHide?: (() => void) | undefined }) {
  const lit = column.tasks.length > 0;
  const lamp = COLUMN_LAMP[column.id];
  return (
    <div className="flex shrink-0 flex-col gap-2 px-1">
      <div className="flex h-7 items-center gap-2">
        <Lamp state={lamp} dim={!lit} size={8} />
        <h2 className="text-base leading-[18px] font-semibold">{column.label}</h2>
        <span
          className={cn(
            "tnum ml-auto font-mono text-sm",
            lit && lamp !== "idle" ? LAMP_TEXT[lamp] : "text-fg-muted",
          )}
        >
          {column.tasks.length}
        </span>
        {onHide && (
          <button
            type="button"
            aria-label="Fold Done"
            title="Fold Done"
            onClick={onHide}
            className="-mr-1 grid size-6 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-raised hover:text-fg"
          >
            <ChevronsRight aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
      <span aria-hidden="true" className="h-px bg-[linear-gradient(90deg,var(--c-hair),transparent_85%)]" />
    </div>
  );
}

function BoardColumn({
  column,
  orgs,
  filterOrg,
  onHide,
}: {
  column: Column;
  orgs: readonly OrgView[];
  filterOrg: string | undefined;
  onHide?: (() => void) | undefined;
}) {
  return (
    <section aria-label={column.label} className="flex min-h-0 min-w-[228px] flex-1 flex-col gap-2.5">
      <ColumnHead column={column} onHide={onHide} />
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-1 pt-0.5 pb-6 scroll-fade">
        {column.tasks.map((task, index) => (
          <BoardCard key={task.id} task={task} orgs={orgs} filterOrg={filterOrg} index={index} />
        ))}
      </div>
    </section>
  );
}

/** An empty column, or Done while folded: a slim rail with its name and count. */
function ColumnRail({
  column,
  searching,
  onOpen,
}: {
  column: Column;
  searching: boolean;
  onOpen?: (() => void) | undefined;
}) {
  const count = column.tasks.length;
  const inner = (
    <>
      <Lamp state={COLUMN_LAMP[column.id]} dim={count === 0} size={7} />
      <h2 className="text-sm font-medium text-fg-soft [writing-mode:vertical-rl]">{column.label}</h2>
      <span className="tnum font-mono text-sm text-fg-muted">{count}</span>
    </>
  );
  const frame =
    "flex w-11 shrink-0 flex-col items-center gap-3 rounded-2xl border border-dashed border-line-control py-3.5";
  return (
    <section
      aria-label={column.label}
      title={searching && count === 0 ? `No match in ${column.label}` : undefined}
      className="flex shrink-0"
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Show ${count} done`}
          className={cn(
            frame,
            "cursor-pointer bg-raised transition-colors duration-150 hover:border-line-hover hover:bg-selected",
          )}
        >
          {inner}
        </button>
      ) : (
        <div className={frame}>{inner}</div>
      )}
    </section>
  );
}

function BoardSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading tasks" className="flex min-h-0 flex-1 gap-3">
      {["inbox", "working", "needs"].map((id, col) => (
        <div key={id} className="flex min-w-[228px] flex-1 flex-col gap-2.5">
          <Skeleton className="h-7 w-28" />
          {Array.from({ length: Math.max(1, 3 - col) }, (_, i) => `${id}-${i}`).map((key) => (
            <Skeleton key={key} className="h-[96px] w-full rounded-xl" />
          ))}
        </div>
      ))}
      <Skeleton className="h-full w-11 rounded-2xl" />
      <Skeleton className="h-full w-11 rounded-2xl" />
    </div>
  );
}

function EmptyBoard({ onNew, noProjects }: { onNew: () => void; noProjects: boolean }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div
        className={cn(
          "flex max-w-[440px] animate-rise flex-col items-center gap-3 rounded-2xl px-8 py-9 text-center",
          GLASS,
        )}
      >
        <span className="flex size-11 items-center justify-center rounded-xl border border-accent-line bg-accent-wash text-accent-text">
          <ListChecks aria-hidden="true" className="size-5" />
        </span>
        <h2 className="text-md font-semibold">Nothing on the board yet</h2>
        <p className="text-base text-fg-muted text-pretty">
          Add a task and the team picks it up. Name a project and majhi sets up a worktree on its own branch.
          {noProjects &&
            " Add your projects in Projects and links first to work on code; chat tasks work without one."}
        </p>
        <Button variant="primary" size="lg" onClick={onNew} className="font-semibold">
          <Plus aria-hidden="true" strokeWidth={2.5} />
          New task
          <Kbd aria-hidden="true">n</Kbd>
        </Button>
      </div>
    </div>
  );
}
