import type { Conversation } from "@majhi/shared";
import { PAGE_PATH } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { ChatRoom } from "@/features/boss/boss-conversation";
import { Thread } from "@/features/captain/conversation";
import { ConversationList } from "@/features/chats/conversation-list";
import { rowTitle, workspaceOf, workspaces } from "@/features/chats/model";
import { WorkspaceTabs } from "@/features/chats/workspace-tabs";
import { useCaptainStatus } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { useConversations } from "@/lib/conversation-queries";
import { GLASS_STRONG } from "@/lib/glass";
import { useOrgs } from "@/lib/studio-queries";
import { useTask } from "@/lib/task-queries";

/**
 * The dock's panel: the same list as the Chats page, with the same workspace tab and filters, and one
 * conversation open in place with a way back. Its code is read when the panel first opens. The room inside
 * is the same view the task page and the Captain page show, so sending, cards and reading marks work as there.
 */
export default function DockPanel({ onClose }: { onClose: () => void }) {
  const list = useConversations();
  const orgs = useOrgs().data;
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null);
  // Focus moves into the panel when it opens, so Esc closes it; the message box takes it from there.
  useEffect(() => panel.current?.focus(), []);
  // The list is patched by the feed; opening the panel reads it once, for titles and finished tasks.
  const refetch = list.refetch;
  useEffect(() => {
    void refetch();
  }, [refetch]);
  const open = list.data?.find((c) => c.id === openId);
  const navigate = useNavigate();
  // A client's chat has its own page, with its Replies switch and held replies: the dock goes there.
  const openRow = (row: Conversation) => {
    if (row.kind === "client") {
      onClose();
      void navigate({ to: "/chats/$taskId", params: { taskId: row.id } });
      return;
    }
    setOpenId(row.id);
  };
  const workspace = (c: Conversation) => workspaceOf(c, workspaces(orgs)).name;

  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-label="Chats"
      className={cn(
        "fixed right-4 bottom-[164px] z-40 flex h-[min(620px,calc(100dvh-188px))] w-[min(420px,calc(100vw-32px))] animate-fade-in flex-col overflow-hidden rounded-2xl outline-none",
        GLASS_STRONG,
      )}
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-2">
        {open !== undefined && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back to the chats"
            onClick={() => setOpenId(undefined)}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
        )}
        <h2 className="min-w-0 flex-1 truncate px-1 text-md font-semibold">
          {open === undefined ? "Chats" : rowTitle(open, workspace(open))}
        </h2>
        {open !== undefined && <OpenFull row={open} onDone={onClose} />}
        <Button variant="ghost" size="icon-sm" aria-label="Close the chats" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      {open !== undefined ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2.5">
          {open.kind === "captain" ? <CaptainChat id={open.id} /> : <TaskChat id={open.id} />}
        </div>
      ) : (
        <>
          <div className="shrink-0 p-2 pb-0">
            <WorkspaceTabs list={list.data ?? []} orgs={orgs} />
          </div>
          <ConversationList onOpen={openRow} onNewChat={setOpenId} />
        </>
      )}
    </div>
  );
}

/** Opens the conversation on its own page: the task page, or the workspace's thread on the Captain page. */
function OpenFull({ row, onDone }: { row: Conversation; onDone: () => void }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Open on its page"
      title="Open on its page"
      onClick={() => {
        onDone();
        if (row.kind === "captain") {
          void navigate({ to: PAGE_PATH.captain, search: row.org === undefined ? {} : { thread: row.org } });
        } else if (row.kind === "agent") {
          void navigate({ to: "/chats/$taskId", params: { taskId: row.id } });
        } else void navigate({ to: "/t/$taskId", params: { taskId: row.id } });
      }}
    >
      <ExternalLink aria-hidden="true" />
    </Button>
  );
}

/** A task's room: the same view as the task page's room. */
function TaskChat({ id }: { id: string }) {
  const task = useTask(id);
  if (task.data === undefined) return <RowsSkeleton rows={3} height={48} />;
  return <ChatRoom key={id} task={task.data} />;
}

/** A workspace's captain thread: the same log and box as on the Captain page. */
function CaptainChat({ id }: { id: string }) {
  const orgs = useCaptainStatus().data?.orgs;
  const org = orgs?.find((o) => o.lane === id);
  if (org === undefined) return <RowsSkeleton rows={3} height={48} />;
  return <Thread key={id} org={org} />;
}
