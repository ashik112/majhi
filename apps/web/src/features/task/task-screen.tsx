import { Link, useParams } from "@tanstack/react-router";
import { SearchX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { permissionDomId } from "@/features/room/items";
import { isWorking } from "@/features/room/model";
import { RoomPane } from "@/features/room/room-pane";
import { useRoom } from "@/features/room/use-room";
import { setPendingPermission } from "@/lib/attention";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useTask } from "@/lib/task-queries";
import { briefBody, briefLabel, firstPendingPermission } from "./model";
import { RoomPanel } from "./room-panel";
import { TaskHeader } from "./task-header";

/** `/t/<id>`: the header, the room in the main column and the panel on the right. */
export function TaskScreen() {
  const { taskId } = useParams({ from: "/t/$taskId" });
  return <TaskView key={taskId} taskId={taskId} />;
}

function TaskView({ taskId }: { taskId: string }) {
  const task = useTask(taskId);
  const room = useRoom(taskId);
  const { org } = useOrgFilter();

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
      <div className="flex min-h-0 flex-1 gap-[22px] px-8 pt-[18px] pb-[22px]">
        <RoomPane
          task={data}
          state={room.state}
          dispatch={room.dispatch}
          loadOlder={room.loadOlder}
          top={brief ? <Brief label={briefLabel(data)} text={brief} /> : undefined}
        />
        <RoomPanel task={data} agents={room.state.agents} items={room.state.items} yourTurn={yourTurn} />
      </div>
    </div>
  );
}

/** What the owner wrote, verbatim, above the room. Long briefs fold. */
function Brief({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420 || text.split("\n").length > 6;
  return (
    <section
      aria-label="Task brief"
      className="flex shrink-0 flex-col gap-1.5 rounded-[10px] border border-line-strong bg-card px-3.5 py-3"
    >
      <SectionLabel>{label}</SectionLabel>
      <p
        className={
          long && !open
            ? "line-clamp-5 text-body leading-[1.55] whitespace-pre-wrap break-words text-[#d5d7dc]"
            : "max-h-[40vh] overflow-y-auto text-body leading-[1.55] whitespace-pre-wrap break-words text-[#d5d7dc]"
        }
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="w-fit cursor-pointer rounded-xs text-sm text-fg-muted hover:text-fg"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </section>
  );
}
