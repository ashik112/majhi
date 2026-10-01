import { Link, useParams, useSearch } from "@tanstack/react-router";
import { SearchX } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChangesView } from "@/features/changes/changes-view";
import { hasMemoryTab, TaskMemory } from "@/features/memory/task-memory";
import { permissionDomId } from "@/features/room/items";
import { isWorking } from "@/features/room/model";
import { RoomPane } from "@/features/room/room-pane";
import { useRoom } from "@/features/room/use-room";
import { setPendingPermission } from "@/lib/attention";
import { useFacts, useTaskRecord } from "@/lib/memory-queries";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useTask } from "@/lib/task-queries";
import { briefBody, firstPendingPermission } from "./model";
import { RoomPanel } from "./room-panel";
import { TaskHeader } from "./task-header";
import { TAB_PANEL_ID, type TaskTab, TaskTabs, tabId } from "./task-tabs";
import { TaskTerminal } from "./task-terminal";

// The viewer and its code view load when a file is first opened.
const FileViewer = lazy(() =>
  import("@/features/viewer/file-viewer").then((m) => ({ default: m.FileViewer })),
);

/** `/t/<id>`: the header, the room in the main column and the panel on the right. */
export function TaskScreen() {
  const { taskId } = useParams({ from: "/t/$taskId" });
  return <TaskView key={taskId} taskId={taskId} />;
}

function TaskView({ taskId }: { taskId: string }) {
  const task = useTask(taskId);
  const room = useRoom(taskId);
  const { org } = useOrgFilter();
  const { file } = useSearch({ from: "/t/$taskId" });
  const [tab, setTab] = useState<TaskTab>("room");
  const showChanges = useCallback(() => setTab("changes"), []);
  const facts = useFacts();
  const record = useTaskRecord(taskId);

  // The shell's banner points at a prompt waiting in this room.
  const pending = useMemo(() => firstPendingPermission(room.state.items), [room.state.items]);
  useEffect(() => {
    setPendingPermission(
      pending
        ? { task: taskId, agent: pending.agent, elementId: permissionDomId(pending.itemId) }
        : undefined,
    );
    return () => setPendingPermission(undefined);
  }, [pending, taskId]);

  if (task.isError) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-6">
        <div className="flex max-w-[400px] flex-col items-center gap-3 text-center">
          <SearchX aria-hidden="true" className="size-5 text-fg-faint" />
          <h1 className="text-md font-semibold">Could not open {taskId}</h1>
          <p className="text-base text-fg-muted text-pretty">{task.error.message}</p>
          <Button asChild variant="secondary">
            <Link to="/" search={orgSearch(org)}>
              Back to board
            </Link>
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
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
        <div className="flex flex-col gap-3 rounded-2xl border border-glass-line bg-glass px-5 pt-3.5 pb-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-7 w-2/3" />
        </div>
        <div className="flex flex-1 gap-3">
          <div className="flex flex-1 flex-col gap-3">
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
          <div className="flex w-[380px] flex-col gap-3">
            <Skeleton className="h-48 w-full rounded-xl" />
            <Skeleton className="h-28 w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  const data = task.data;
  const taskFacts = (facts.data ?? []).filter((f) => f.task === data.id);
  const memoryTab = hasMemoryTab(data, taskFacts, record.data);
  // A tab that is gone (a task with no facts left) falls back to the room.
  const shown = tab === "memory" && !memoryTab ? "room" : tab;
  const brief = briefBody(data.brief, data.title);
  const yourTurn =
    data.status === "running" && room.state.loaded && !room.state.agents.some((a) => isWorking(a));

  const tabs: TaskTab[] = [
    "room",
    ...(data.repos.length > 0 ? (["changes"] as const) : []),
    ...(memoryTab ? (["memory"] as const) : []),
    "terminal",
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <TaskHeader
        task={data}
        yourTurn={yourTurn}
        brief={brief}
        tabs={<TaskTabs tabs={tabs} value={shown} onChange={setTab} />}
      />
      <div className="flex min-h-0 flex-1 gap-4 pl-1">
        <div
          id={TAB_PANEL_ID}
          role="tabpanel"
          aria-labelledby={tabId(shown)}
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
        >
          {/* The room stays mounted while another tab shows, so a draft and the scroll place are kept. */}
          <div className={shown === "room" ? "contents" : "hidden"}>
            <RoomPane
              task={data}
              state={room.state}
              dispatch={room.dispatch}
              loadOlder={room.loadOlder}
              onShowChanges={showChanges}
            />
          </div>
          {shown === "changes" && data.repos.length > 0 && (
            <ChangesView task={data} onSent={(item) => room.dispatch({ type: "local", item })} />
          )}
          {shown === "memory" && <TaskMemory task={data} />}
          {shown === "terminal" && <TaskTerminal task={data} />}
        </div>
        <RoomPanel
          task={data}
          agents={room.state.agents}
          items={room.state.items}
          processes={room.state.processes}
          onShowChanges={data.repos.length > 0 ? showChanges : undefined}
        />
      </div>
      {file !== undefined && (
        <Suspense fallback={null}>
          <FileViewer
            taskId={data.id}
            folder={data.folder}
            path={file}
            items={room.state.items}
            repos={data.repos}
          />
        </Suspense>
      )}
    </div>
  );
}
