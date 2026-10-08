import type { Conversation } from "@majhi/shared";
import { PAGE_PATH } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { ChatRoom } from "@/features/boss/boss-conversation";
import { ConversationList } from "@/features/chats/conversation-list";
import { conversationName, workspaceOf, workspaces } from "@/features/chats/model";
import { WorkspaceTabs } from "@/features/chats/workspace-tabs";
import { useCaptainStatus } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { useConversations } from "@/lib/conversation-queries";
import { GLASS_STRONG } from "@/lib/glass";
import { useOrgs } from "@/lib/studio-queries";
import { useTask } from "@/lib/task-queries";

/**
 * The bubble's panel: the same list as the Chats page, newest first, with the same workspace tabs and
 * filters, and one conversation open in place with a way back. Its code is read when the panel first opens.
 * The room inside is the same view the Chats page shows, so sending, cards and reading marks work as there.
 */
export default function DockPanel({ onClose }: { onClose: () => void }) {
  const list = useConversations();
  const orgs = useOrgs().data;
  const captain = useCaptainStatus().data?.captain;
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
  // A client's chat has its own page, with its Replies switch and held replies: the bubble goes there.
  const openRow = (row: Conversation) => {
    if (row.kind === "client") {
      onClose();
      void navigate({ to: "/chats/$taskId", params: { taskId: row.id } });
      return;
    }
    if (row.kind === "captain") {
      onClose();
      void navigate({ to: PAGE_PATH.captain, search: row.org === undefined ? {} : { thread: row.org } });
      return;
    }
    setOpenId(row.id);
  };
  const title = (c: Conversation) =>
    conversationName(
      c,
      workspaceOf(c, workspaces(orgs)).name,
      c.kind === "agent" && c.org === undefined && c.agent === captain,
    );

  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-label="Chats"
      className={cn(
        "fixed right-4 bottom-[72px] z-40 flex h-[min(620px,calc(100dvh-72px-72px))] w-[min(420px,calc(100vw-32px))] animate-fade-in flex-col overflow-hidden rounded-2xl outline-none",
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
          {open === undefined ? "Chats" : title(open)}
        </h2>
        {open !== undefined && <OpenFull row={open} onDone={onClose} />}
        <Button variant="ghost" size="icon-sm" aria-label="Close the chats" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      {open !== undefined ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2.5">
          <TaskChat id={open.id} />
        </div>
      ) : (
        <>
          <div className="shrink-0 p-2 pb-0">
            <WorkspaceTabs list={list.data ?? []} orgs={orgs} compact />
          </div>
          <ConversationList onOpen={openRow} onNewChat={setOpenId} />
        </>
      )}
    </div>
  );
}

/** Opens the conversation on its own page. */
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

/** A chat's room: the same view as the Chats page's room. */
function TaskChat({ id }: { id: string }) {
  const task = useTask(id);
  if (task.data === undefined) return <RowsSkeleton rows={3} height={48} />;
  return <ChatRoom key={id} task={task.data} />;
}
