import type { Task } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { Pencil, SearchX, SquarePen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OrgBadge } from "@/components/ui/org-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { permissionDomId } from "@/features/room/items";
import { RoomPane } from "@/features/room/room-pane";
import { useRoom } from "@/features/room/use-room";
import { firstPendingPermission } from "@/features/task/model";
import { useAgentIndex } from "@/lib/agent-index";
import { setPendingPermission } from "@/lib/attention";
import { useRenameChat } from "@/lib/chat-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { badgeLetters } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useLaneRedirect } from "@/lib/lane-link";
import { useOrgs } from "@/lib/studio-queries";
import { useTask } from "@/lib/task-queries";
import { chatTitle } from "./model";

/** One conversation: a header with the agent and the title, then the room with its composer. */
export function ChatView({
  taskId,
  renaming,
  onRenamed,
  onRename,
  onNew,
  creating,
}: {
  taskId: string;
  renaming: boolean;
  onRenamed: () => void;
  onRename: () => void;
  onNew: (agent: string) => void;
  creating: boolean;
}) {
  const task = useTask(taskId);
  useLaneRedirect(task.data);
  if (task.isError) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-6">
        <div className="flex max-w-[400px] flex-col items-center gap-3 text-center">
          <SearchX aria-hidden="true" className="size-5 text-fg-faint" />
          <h1 className="text-md font-semibold">Could not open this chat</h1>
          <p className="text-base text-fg-muted text-pretty">{describeError(task.error)}</p>
          <Button asChild variant="secondary">
            <Link to="/chats">Back to chats</Link>
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
        aria-label="Loading the chat"
        className="flex flex-1 flex-col gap-3"
      >
        <Skeleton className="h-14 w-full rounded-2xl" />
        <Skeleton className="h-20 w-2/3 rounded-lg" />
      </div>
    );
  }
  return (
    <OpenChat
      key={task.data.id}
      task={task.data}
      renaming={renaming}
      onRenamed={onRenamed}
      onRename={onRename}
      onNew={onNew}
      creating={creating}
    />
  );
}

function OpenChat({
  task,
  renaming,
  onRenamed,
  onRename,
  onNew,
  creating,
}: {
  task: Task;
  renaming: boolean;
  onRenamed: () => void;
  onRename: () => void;
  onNew: (agent: string) => void;
  creating: boolean;
}) {
  const room = useRoom(task.id);
  const agent = task.team[0];
  const info = useAgentIndex().get(agent ?? "");
  const org = useOrgs().data?.find((o) => o.id === task.org);

  // The shell's banner points at a prompt waiting in this room.
  const pending = useMemo(() => firstPendingPermission(room.state.items), [room.state.items]);
  useEffect(() => {
    setPendingPermission(
      pending
        ? { task: task.id, agent: pending.agent, elementId: permissionDomId(pending.itemId) }
        : undefined,
    );
    return () => setPendingPermission(undefined);
  }, [pending, task.id]);

  const detail = [
    info?.role,
    info === undefined
      ? undefined
      : `${info.account} · ${info.model ?? "default model"}${info.effort ? ` ${info.effort}` : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const empty = room.state.loaded && room.state.items.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <header className={cn("flex shrink-0 items-center gap-3 rounded-2xl px-4 py-2.5", GLASS)}>
        {agent && <AgentAvatar id={agent} size={32} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <Title task={task} renaming={renaming} onDone={onRenamed} onRename={onRename} />
          <div className="flex min-w-0 items-center gap-2 text-xs text-fg-faint">
            {agent && <span className="shrink-0 font-mono">@{agent}</span>}
            {detail && <span className="min-w-0 truncate">{detail}</span>}
            {org && (
              <span className="flex shrink-0 items-center gap-1.5">
                <OrgBadge label={badgeLetters(org.key)} color={org.color} size="xs" />
                {org.name}
              </span>
            )}
            {task.status === "done" && <span className="shrink-0">Archived. Write to continue it.</span>}
          </div>
        </div>
        {agent && (
          <Button size="sm" disabled={creating} onClick={() => onNew(agent)}>
            <SquarePen aria-hidden="true" />
            New chat
          </Button>
        )}
      </header>
      {empty && (
        <p className="shrink-0 px-1 text-sm text-fg-faint text-pretty">
          Just chatting: nothing here becomes a task unless you ask {agent ? `@${agent}` : "the agent"} to
          make one.
        </p>
      )}
      <RoomPane task={task} state={room.state} dispatch={room.dispatch} loadOlder={room.loadOlder} />
    </div>
  );
}

function Title({
  task,
  renaming,
  onDone,
  onRename,
}: {
  task: Task;
  renaming: boolean;
  onDone: () => void;
  onRename: () => void;
}) {
  const rename = useRenameChat();
  const toast = useToast();
  const [draft, setDraft] = useState(chatTitle(task));
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renaming) return;
    setDraft(chatTitle(task));
    field.current?.select();
  }, [renaming, task]);

  function commit() {
    const title = draft.trim();
    onDone();
    if (title === "" || title === chatTitle(task)) return;
    rename.mutate(
      { id: task.id, title },
      { onError: (error) => toast("Could not rename", { detail: describeError(error), tone: "error" }) },
    );
  }

  if (renaming) {
    return (
      <Input
        ref={field}
        aria-label="Chat title"
        autoFocus
        maxLength={120}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            event.stopPropagation();
            onDone();
          }
        }}
        className="h-7 text-md font-semibold"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={onRename}
      title="Rename"
      className="group flex min-w-0 items-center gap-1.5 self-start rounded-md text-left"
    >
      <h1 className="min-w-0 truncate text-md font-semibold">{chatTitle(task)}</h1>
      <Pencil
        aria-hidden="true"
        className="size-3 shrink-0 text-fg-faint opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  );
}
