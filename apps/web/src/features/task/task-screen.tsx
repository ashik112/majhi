import type { Task } from "@majhi/shared";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { SearchX } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ChangesView } from "@/features/changes/changes-view";
import { permissionDomId } from "@/features/room/items";
import { Markdown } from "@/features/room/markdown";
import { isWorking } from "@/features/room/model";
import { RoomPane } from "@/features/room/room-pane";
import { useRoom } from "@/features/room/use-room";
import { linkifyPaths } from "@/features/viewer/model";
import { setPendingPermission } from "@/lib/attention";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useTask, useUpdateTask } from "@/lib/task-queries";
import { briefBody, briefLabel, firstPendingPermission } from "./model";
import { RoomPanel } from "./room-panel";
import { TaskHeader } from "./task-header";

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
  const [tab, setTab] = useState<"room" | "changes">("room");

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
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex flex-col gap-3 border-b border-line px-8 pt-3.5 pb-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-7 w-2/3" />
        </div>
        <div className="flex flex-1 gap-[22px] px-8 pt-[18px] pb-[22px]">
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
  const brief = briefBody(data.brief, data.title);
  const yourTurn =
    data.status === "running" && room.state.loaded && !room.state.agents.some((a) => isWorking(a));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TaskHeader task={data} yourTurn={yourTurn} />
      <div className="flex min-h-0 flex-1 gap-4 px-5 pt-3 pb-3">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {data.repos.length > 0 && (
            <Segmented
              label="Room or changes"
              value={tab}
              onChange={setTab}
              segments={[
                { value: "room", label: "Room" },
                { value: "changes", label: "Changes" },
              ]}
              className="w-fit"
            />
          )}
          {/* The room stays mounted while Changes shows, so a draft and the scroll place are kept. */}
          <div className={tab === "room" || data.repos.length === 0 ? "contents" : "hidden"}>
            <RoomPane
              task={data}
              state={room.state}
              dispatch={room.dispatch}
              loadOlder={room.loadOlder}
              top={brief ? <Brief label={briefLabel(data)} text={brief} task={data} /> : undefined}
            />
          </div>
          {tab === "changes" && data.repos.length > 0 && <ChangesView task={data} />}
        </div>
        <RoomPanel
          task={data}
          agents={room.state.agents}
          items={room.state.items}
          processes={room.state.processes}
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

/** What the owner wrote, as markdown. File paths in it open in the viewer, from the task's project. Long briefs fold. */
function Brief({ label, text, task }: { label: string; text: string; task: Task }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const update = useUpdateTask();
  const toast = useToast();
  const long = text.length > 420 || text.split("\n").length > 6;
  const source = useMemo(() => linkifyPaths(text), [text]);
  const files = useMemo(
    () => ({ id: task.id, folder: task.folder, project: task.repos[0]?.project }),
    [task.id, task.folder, task.repos],
  );
  return (
    <section
      aria-label="Task brief"
      className="flex shrink-0 flex-col gap-1 rounded-lg border border-line-strong bg-card px-3 py-2"
    >
      <div className="flex items-center">
        <SectionLabel>{label}</SectionLabel>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setValue(text);
              setEditing(true);
            }}
            className="ml-auto cursor-pointer rounded-xs text-xs text-fg-muted hover:text-fg"
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label="Task description"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={8}
            className="max-h-[40vh] w-full resize-y rounded-md border border-line-control bg-field p-2 text-body text-fg focus-visible:border-blue focus-visible:outline-none"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: task.id, brief: value },
                  {
                    onSuccess: () => setEditing(false),
                    onError: (e) => toast("Could not save", { detail: e.message, tone: "error" }),
                  },
                )
              }
            >
              Save
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={
            long && !open
              ? "max-h-[5.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
              : "max-h-[40vh] overflow-y-auto"
          }
        >
          <Markdown text={source} task={files} />
        </div>
      )}
      {long && !editing && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="w-fit cursor-pointer rounded-xs text-xs text-fg-muted hover:text-fg"
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </section>
  );
}
