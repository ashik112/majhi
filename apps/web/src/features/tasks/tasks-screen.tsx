import { Link, useNavigate } from "@tanstack/react-router";
import { FolderGit2, PanelRightClose, PanelRightOpen, SearchX } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChangesPanel } from "@/features/room/changes-panel";
import { RoomPane } from "@/features/room/room-pane";
import { useRoom } from "@/features/room/use-room";
import { cn } from "@/lib/cn";
import { useOrgs } from "@/lib/studio-queries";
import { useProjects, useTask, useTasks } from "@/lib/task-queries";
import { groupTasks, moveCursor, visibleTaskIds } from "./model";
import { TaskBox } from "./task-box";
import { rowDomId, TaskList } from "./task-list";

const DETAILS_KEY = "majhi.details-open";

function readDetailsOpen(): boolean {
  try {
    return window.localStorage.getItem(DETAILS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** The main screen: task box and list on the left, the room in the middle, details on the right. */
export function TasksScreen({ taskId }: { taskId?: string | undefined }) {
  const [detailsOpen, setDetailsOpen] = useState(readDetailsOpen);
  const toggleDetails = useCallback(() => {
    setDetailsOpen((open) => {
      try {
        window.localStorage.setItem(DETAILS_KEY, open ? "0" : "1");
      } catch {
        // The choice just is not remembered.
      }
      return !open;
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1">
      <LeftColumn openId={taskId} />
      {taskId ? (
        <Workspace key={taskId} taskId={taskId} detailsOpen={detailsOpen} onToggleDetails={toggleDetails} />
      ) : (
        <NoTask />
      )}
    </div>
  );
}

function LeftColumn({ openId }: { openId: string | undefined }) {
  const tasks = useTasks();
  const orgs = useOrgs().data ?? [];
  const projects = useProjects();
  const navigate = useNavigate();
  const [doneOpen, setDoneOpen] = useState(false);
  const [cursorId, setCursorId] = useState<string | undefined>();

  const groups = useMemo(() => groupTasks(tasks.data ?? []), [tasks.data]);
  const ids = useMemo(() => visibleTaskIds(groups, doneOpen), [groups, doneOpen]);

  // j and k or the arrows move a cursor over the rows, Enter opens the one under it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (target?.closest('dialog, [role="log"], [role="menu"]')) return;
      const onRow = target?.closest("[data-task-row]") != null;
      let delta = 0;
      if (event.key === "j" || event.key === "ArrowDown") delta = 1;
      else if (event.key === "k" || event.key === "ArrowUp") delta = -1;
      else if (event.key === "Enter") {
        if (onRow || target?.closest("button, a, summary")) return;
        if (cursorId) {
          event.preventDefault();
          void navigate({ to: "/t/$taskId", params: { taskId: cursorId } });
        }
        return;
      } else return;
      event.preventDefault();
      const next = moveCursor(ids, cursorId ?? openId, delta);
      if (!next) return;
      setCursorId(next);
      document.getElementById(rowDomId(next))?.scrollIntoView({ block: "nearest" });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ids, cursorId, openId, navigate]);

  const noRepos = projects.isSuccess && projects.data.length === 0;

  return (
    <section aria-label="Tasks" className="flex w-[362px] shrink-0 flex-col border-r border-line bg-rail">
      <TaskBox />
      {noRepos && (
        <p className="flex items-start gap-2 border-b border-line px-3.5 py-2.5 text-sm text-fg-muted">
          <FolderGit2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber" />
          <span>
            No repos registered yet.{" "}
            <Link to="/repos" className="text-fg underline underline-offset-2">
              Register a repo
            </Link>{" "}
            to work on code. Chat tasks work without one.
          </span>
        </p>
      )}
      {tasks.isPending ? (
        <div role="status" className="flex flex-col gap-2 p-3" aria-busy="true" aria-label="Loading tasks">
          {["a", "b", "c"].map((k) => (
            <Skeleton key={k} className="h-[76px] w-full rounded-lg" />
          ))}
        </div>
      ) : tasks.isError ? (
        <p role="alert" className="p-4 text-sm text-red">
          Could not load tasks. {tasks.error.message}
        </p>
      ) : groups.length === 0 ? (
        <p className="p-4 text-sm text-fg-faint text-pretty">No tasks yet. Describe one in the box above.</p>
      ) : (
        <TaskList
          groups={groups}
          orgs={orgs}
          openId={openId}
          cursorId={cursorId}
          doneOpen={doneOpen}
          onToggleDone={() => setDoneOpen((v) => !v)}
        />
      )}
    </section>
  );
}

function NoTask() {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-[380px] flex-col gap-2 text-center">
        <h1 className="text-md font-semibold">Pick a task, or write a new one</h1>
        <p className="text-base text-fg-muted text-pretty">
          The room shows what the agent says and does. Use J and K to move through the list and Enter to open
          one.
        </p>
      </div>
    </div>
  );
}

function Workspace({
  taskId,
  detailsOpen,
  onToggleDetails,
}: {
  taskId: string;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const task = useTask(taskId);
  const room = useRoom(taskId);

  if (task.isError) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-6">
        <div className="flex max-w-[400px] flex-col items-center gap-3 text-center">
          <SearchX aria-hidden="true" className="size-5 text-fg-faint" />
          <h1 className="text-md font-semibold">Could not open {taskId}</h1>
          <p className="text-base text-fg-muted text-pretty">{task.error.message}</p>
          <Button asChild variant="secondary">
            <Link to="/">Back to tasks</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!task.data) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={`Loading ${taskId}`}
        className="flex min-w-0 flex-1 flex-col gap-3 p-6"
      >
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  return (
    <>
      <RoomPane task={task.data} state={room.state} dispatch={room.dispatch} loadOlder={room.loadOlder} />
      <aside
        aria-label="Task details"
        className={cn(
          "flex shrink-0 flex-col border-l border-line bg-rail",
          detailsOpen ? "w-[350px]" : "w-11",
        )}
      >
        <div
          role="tablist"
          aria-label="Details"
          className="flex items-center gap-0.5 border-b border-line px-2.5 pt-2"
        >
          {detailsOpen && (
            <button
              type="button"
              role="tab"
              id="tab-changes"
              aria-selected="true"
              aria-controls="panel-changes"
              className="h-[38px] border-b-2 border-amber px-3 text-base text-fg"
            >
              Changes
            </button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn("mb-1", detailsOpen ? "ml-auto" : "mx-auto")}
            aria-label={detailsOpen ? "Collapse details" : "Expand details"}
            aria-expanded={detailsOpen}
            onClick={onToggleDetails}
          >
            {detailsOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
          </Button>
        </div>
        {detailsOpen && (
          <div
            role="tabpanel"
            id="panel-changes"
            aria-labelledby="tab-changes"
            className="min-h-0 flex-1 overflow-y-auto p-3.5"
          >
            <ChangesPanel task={task.data} items={room.state.items} />
          </div>
        )}
      </aside>
    </>
  );
}
