import { useNavigate, useSearch } from "@tanstack/react-router";
import { ListChecks, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { useOrgFilter } from "@/lib/org-filter";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import { useProjects, useTasks } from "@/lib/task-queries";
import { useNewTask } from "../new-task/new-task-context";
import { BoardCard, cardDomId } from "./board-card";
import { boardCounts, buildColumns, COLUMN_DOT, directionOf, isBossChat, moveFocus } from "./model";
import { TreeView } from "./tree-view";

/** Keys the board answers while focus is on a card or on the page itself, not in a field or dialog. */
function boardKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return false;
  return target.closest("dialog, [role='menu']") === null;
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
  const columns = useMemo(() => buildColumns(all, { org, query, showDone }), [all, org, query, showDone]);
  const counts = boardCounts(all, org);
  const onlyIds = useMemo(() => columns.map((c) => c.tasks.map((t) => t.id)), [columns]);

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
      document.getElementById(cardDomId(next))?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const empty = tasks.isSuccess && all.length === 0;
  const noProjects = projects.isSuccess && projects.data.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Board"
        subtitle={
          <span className="tnum">
            {counts.open} open
            {counts.done > 0 && (
              <>
                {" · "}
                <button
                  type="button"
                  aria-pressed={showDone}
                  onClick={() => setShowDone((v) => !v)}
                  className="cursor-pointer rounded-xs underline decoration-line-hover decoration-dotted underline-offset-4 hover:text-fg"
                >
                  {counts.done} done{showDone ? ", hide" : ", show"}
                </button>
              </>
            )}
          </span>
        }
      >
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
          Search tasks
        </label>
        <input
          id="task-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tasks"
          autoComplete="off"
          spellCheck={false}
          className="h-10 w-[200px] rounded-md border border-line-strong bg-field px-3 text-base text-fg transition-colors duration-150 hover:border-line-hover focus-visible:border-blue focus-visible:outline-none"
        />
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
      </PageHeader>

      {tasks.isPending ? (
        <BoardSkeleton />
      ) : tasks.isError ? (
        <p role="alert" className="p-8 text-base text-red">
          Could not load tasks. {tasks.error.message}
        </p>
      ) : empty ? (
        <EmptyBoard onNew={newTask.open} noProjects={noProjects} />
      ) : tree ? (
        <TreeView
          columns={columns}
          orgs={orgs}
          filterOrg={org}
          empty={query ? "No task matches." : "No open tasks."}
        />
      ) : (
        <div
          className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-4 overflow-x-auto px-8 pt-[22px]"
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(200px, 1fr))` }}
        >
          {columns.map((column) => (
            <section key={column.id} aria-label={column.label} className="flex min-h-0 min-w-0 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-line px-1 pb-2">
                <span aria-hidden="true" className={cn("size-2 rounded-full", COLUMN_DOT[column.id])} />
                <h2 className="text-base leading-[18px] font-semibold">{column.label}</h2>
                <span className="tnum font-mono text-sm leading-[18px] text-fg-faint">
                  {column.tasks.length}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pt-2.5 pb-[22px]">
                {column.tasks.map((task, index) => (
                  <BoardCard key={task.id} task={task} orgs={orgs} filterOrg={org} index={index} />
                ))}
                {column.tasks.length === 0 && (
                  <div className="rounded-lg border border-dashed border-line-strong p-[18px] text-center text-sm text-fg-faint">
                    {query ? "No match" : "Nothing here"}
                  </div>
                )}
                {column.id === "inbox" && (
                  <button
                    type="button"
                    onClick={newTask.open}
                    className="h-10 cursor-pointer rounded-lg border border-dashed border-line-hover text-base text-fg-soft transition-colors duration-150 hover:border-fg-faint hover:bg-raised hover:text-fg"
                  >
                    + Add a task
                  </button>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading tasks"
      className="grid flex-1 grid-cols-5 gap-4 px-8 py-[22px]"
    >
      {["inbox", "ready", "working", "review", "mr"].map((id, col) => (
        <div key={id} className="flex flex-col gap-2.5">
          <Skeleton className="h-4 w-24" />
          {Array.from({ length: Math.max(1, 3 - col) }, (_, i) => `${id}-${i}`).map((key) => (
            <Skeleton key={key} className="h-[104px] w-full rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  );
}

function EmptyBoard({ onNew, noProjects }: { onNew: () => void; noProjects: boolean }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-[400px] animate-rise flex-col items-center gap-3 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl border border-line-strong bg-card text-amber">
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
