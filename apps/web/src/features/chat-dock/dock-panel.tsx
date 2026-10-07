import type { Conversation } from "@majhi/shared";
import { PAGE_PATH } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { OrgBadge } from "@/components/ui/org-badge";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { ChatRoom } from "@/features/boss/boss-conversation";
import { Thread } from "@/features/captain/conversation";
import { shortAgo } from "@/features/tasks/schedule";
import { useCaptainStatus } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { useConversations } from "@/lib/conversation-queries";
import { GLASS_STRONG } from "@/lib/glass";
import { useOrgs } from "@/lib/studio-queries";
import { useTask } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { badgeText, type DockGroup, groupByWorkspace, rowTitle } from "./model";

/**
 * The dock's panel: the conversations grouped by workspace, and one open in place with a way back.
 * Its code is read when the panel first opens. The room inside is the same view the task page and the
 * Captain page show, so sending, cards and reading marks work as they do there.
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
  const groups = useMemo(() => groupByWorkspace(list.data ?? [], orgs), [list.data, orgs]);
  const open = list.data?.find((c) => c.id === openId);
  const navigate = useNavigate();
  // A client's chat has its own page, with its Replies switch and held replies: the dock goes there.
  const openRow = (id: string) => {
    if (list.data?.find((c) => c.id === id)?.kind === "client") {
      onClose();
      void navigate({ to: "/chats/$taskId", params: { taskId: id } });
      return;
    }
    setOpenId(id);
  };
  const workspace = (c: Conversation) => groups.find((g) => g.rows.some((r) => r.id === c.id))?.name ?? "";

  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-label="Chats"
      className={cn(
        "fixed right-4 bottom-[68px] z-40 flex h-[min(620px,calc(100dvh-92px))] w-[min(420px,calc(100vw-32px))] animate-fade-in flex-col overflow-hidden rounded-2xl outline-none",
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
      ) : list.isPending ? (
        <div className="p-3">
          <RowsSkeleton rows={4} height={48} />
        </div>
      ) : groups.length === 0 ? (
        <p className="m-auto max-w-[260px] px-4 py-10 text-center text-sm text-fg-muted text-pretty">
          No chats yet. Replies from agents on your tasks and from the captain show up here.
        </p>
      ) : (
        <GroupList groups={groups} onOpen={openRow} />
      )}
    </div>
  );
}

function GroupList({ groups, onOpen }: { groups: DockGroup[]; onOpen: (id: string) => void }) {
  const now = useNow(60_000);
  return (
    <div className="scroll-fade min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
      {groups.map((g) => (
        <section key={g.org} aria-label={g.name} className="flex flex-col pt-2">
          <h3 className="flex items-center gap-2 px-2 pb-1 text-xs font-medium text-fg-soft">
            <OrgBadge label={g.letters} color={g.color} size="xs" />
            <span className="min-w-0 flex-1 truncate">{g.name}</span>
            {g.unread > 0 && (
              <span className="font-mono text-2xs text-fg-faint tabular-nums">{g.unread} new</span>
            )}
          </h3>
          {g.rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => onOpen(row.id)}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-raised"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-base",
                      row.unread > 0 ? "font-semibold text-fg" : "text-fg-soft",
                    )}
                  >
                    {rowTitle(row, g.name)}
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-fg-faint tabular-nums">
                    {shortAgo(row.lastAt, now)}
                  </span>
                </span>
                <span className="truncate text-sm text-fg-faint">{row.lastLine}</span>
              </span>
              {row.unread > 0 && (
                <span
                  role="img"
                  aria-label={`${row.unread} unread`}
                  className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 font-mono text-2xs font-semibold text-accent-ink tabular-nums"
                >
                  {badgeText(row.unread)}
                </span>
              )}
            </button>
          ))}
        </section>
      ))}
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
