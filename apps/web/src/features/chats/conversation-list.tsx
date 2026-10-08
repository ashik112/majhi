import { CHAT_APP_LABEL, type ClientRow, type Conversation } from "@majhi/shared";
import { Anchor, MoreHorizontal, Search, SquareCheck } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { OrgBadge } from "@/components/ui/org-badge";
import { Segmented } from "@/components/ui/segmented";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { AppMark } from "@/features/clients/app-mark";
import { shortAgo } from "@/features/tasks/schedule";
import { type KindFilter, setChatFilter, useChatFilter } from "@/lib/chat-filter";
import { useNewChat } from "@/lib/chat-queries";
import { useCaptainStatus } from "@/lib/captain-queries";
import { useUnlinkChat } from "@/lib/client-queries";
import { cn } from "@/lib/cn";
import {
  useArchiveConversation,
  useConversationSearch,
  useConversations,
  useMarkConversationRead,
} from "@/lib/conversation-queries";
import { describeError } from "@/lib/errors";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import { useRemoveTask } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import {
  badgeText,
  chatTitle,
  KIND_LABEL,
  rowTitle,
  visibleConversations,
  type Workspace,
  workspaceOf,
  workspaces,
} from "./model";
import { agentEntryOptions } from "./new-chat-options";

const KINDS: readonly { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "client", label: "Clients" },
  { value: "agent", label: "Agents" },
];

/**
 * The one list of chats, newest first: client rooms and the owner's own chats (the Captain, agents). No task rows and
 * no captain threads: those live on the Tasks and Captain pages. The Chats page and the chat bubble both draw it.
 */
const NO_ROWS: readonly never[] = [];

export function ConversationList({
  selected,
  onOpen,
  onNewChat,
  onDeleted,
  top,
  newChats = NO_ROWS,
  className,
}: {
  selected?: string | undefined;
  onOpen: (row: Conversation) => void;
  /** A chat with an agent was started (or the empty one came back). */
  onNewChat: (id: string) => void;
  onDeleted?: (id: string) => void;
  /** Rows above the list, like links for chats nobody linked yet. */
  top?: ReactNode | ((query: string) => ReactNode);
  /** Chats nobody linked yet: an unlinked row of the same chat is not listed twice beside them. */
  newChats?: readonly Pick<ClientRow, "app" | "title">[];
  className?: string;
}) {
  const list = useConversations();
  const orgs = useOrgs().data;
  const filter = useChatFilter();
  const now = useNow(60_000);
  const [query, setQuery] = useState("");
  const all = useMemo(() => workspaces(orgs), [orgs]);
  const tab = filter.tab === "all" || all.some((w) => w.id === filter.tab) ? filter.tab : "all";
  const history = useConversationSearch(query).data;
  const rows = useMemo(
    () =>
      visibleConversations(list.data ?? [], { ...filter, tab }, query, all, new Set(history)).filter(
        (row) =>
          !(
            row.unlinked === true &&
            newChats.some((n) => n.app === row.app && n.title === row.title)
          ),
      ),
    [list.data, filter, tab, query, all, history, newChats],
  );
  const archivedCount = useMemo(
    () => (list.data ?? []).filter((c) => c.archived === true).length,
    [list.data],
  );
  const actions = useRowActions(onDeleted);
  const captain = useCaptainStatus().data?.captain;
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <div className="flex shrink-0 flex-col gap-2 border-b border-line p-2">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-faint"
            />
            <Input
              type="search"
              aria-label="Search chats"
              placeholder="Search chats"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-8"
            />
          </div>
          <NewChat onStarted={onNewChat} />
        </div>
        <Segmented
          label="Kind"
          value={filter.kind}
          segments={KINDS}
          onChange={(kind) => setChatFilter({ kind })}
          className="w-full"
        />
      </div>
      <div className="scroll-fade flex min-h-0 flex-1 flex-col gap-px overflow-y-auto overscroll-contain px-1.5 py-1.5">
        {typeof top === "function" ? top(query) : top}
        {list.isPending ? (
          <RowsSkeleton rows={5} height={52} />
        ) : rows.length === 0 ? (
          <p className="px-2 py-3 text-sm text-fg-faint">
            {query.trim() === "" && !filter.archived ? "No chats yet." : "Nothing matches."}
          </p>
        ) : (
          rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              workspace={workspaceOf(row, all)}
              isCaptain={row.kind === "agent" && row.org === undefined && row.agent === captain}
              active={row.id === selected}
              showKind={filter.kind === "all"}
              now={now}
              onOpen={() => onOpen(row)}
              items={actions.items(row)}
            />
          ))
        )}
      </div>
      {(archivedCount > 0 || filter.archived) && (
        <div className="shrink-0 border-t border-line p-1.5">
          <button
            type="button"
            aria-pressed={filter.archived}
            onClick={() => setChatFilter({ archived: !filter.archived })}
            className={cn(
              "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-raised",
              filter.archived ? "bg-selected text-fg" : "text-fg-muted",
            )}
          >
            Archived
            <span className="tnum font-mono text-xs text-fg-faint">{archivedCount}</span>
          </button>
        </div>
      )}
      {actions.dialog}
    </div>
  );
}

/** "New chat": pick an agent, and its chat opens. */
function NewChat({ onStarted }: { onStarted: (id: string) => void }) {
  const agents = useAgents().data;
  const orgs = useOrgs().data;
  const toast = useToast();
  const start = useNewChat();
  const items: MenuItem[] = useMemo(
    () =>
      agentEntryOptions(agents ?? [], orgs ?? []).map((o) => ({
        label: `@${o.id}`,
        group: o.group,
        icon: <AgentAvatar id={o.id} size={16} decorative />,
        onSelect: () =>
          start.mutate(o.id, {
            onSuccess: (task) => onStarted(task.id),
            onError: (error) =>
              toast("Could not start the chat", { detail: describeError(error), tone: "error" }),
          }),
      })),
    [agents, orgs, start, onStarted, toast],
  );
  return (
    <Menu
      label="New chat"
      items={items}
      maxHeight={420}
      trigger={(props) => (
        <Button size="sm" disabled={start.isPending} {...props}>
          New chat
        </Button>
      )}
    />
  );
}

function KindIcon({ row, isCaptain }: { row: Conversation; isCaptain: boolean }) {
  if (isCaptain) return <Anchor aria-hidden="true" className="size-4" />;
  if (row.kind === "client" && row.app !== undefined) return <AppMark app={row.app} size={16} />;
  if (row.kind === "agent" && row.agent !== undefined)
    return <AgentAvatar id={row.agent} size={20} decorative />;
  if (row.kind === "captain") return <Anchor aria-hidden="true" className="size-4" />;
  return <SquareCheck aria-hidden="true" className="size-4" />;
}

function Row({
  row,
  workspace,
  isCaptain,
  active,
  showKind,
  now,
  onOpen,
  items,
}: {
  row: Conversation;
  workspace: Workspace;
  /** The owner's chat with the captain: it belongs to no workspace, so it has no workspace badge. */
  isCaptain: boolean;
  active: boolean;
  showKind: boolean;
  now: number;
  onOpen: () => void;
  items: MenuItem[];
}) {
  const title = isCaptain ? "Captain" : rowTitle(row, workspace.name);
  const unread = row.archived === true ? 0 : row.unread;
  return (
    <div className="group relative">
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={onOpen}
        className={cn(
          "flex w-full cursor-pointer items-start gap-2.5 rounded-lg py-2 pr-12 pl-2 text-left transition-colors hover:bg-raised",
          active && "bg-selected shadow-[inset_0_0_0_1px_var(--c-line-control)]",
        )}
      >
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-fg-muted">
          <KindIcon row={row} isCaptain={isCaptain} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "min-w-0 truncate text-base",
              unread > 0 ? "font-semibold text-fg" : "text-fg-soft",
            )}
          >
            {title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            {!isCaptain && (
              <OrgBadge
                label={workspace.letters}
                color={workspace.color}
                size="xs"
                className="size-[14px] text-[6px]"
              />
            )}
            {(showKind || isCaptain) && (
              <Badge className="h-4 px-1 text-2xs" data-kind={row.kind}>
                {isCaptain ? "Captain" : KIND_LABEL[row.kind]}
              </Badge>
            )}
            {row.unlinked === true && <Badge className="h-4 px-1 text-2xs">Unlinked</Badge>}
            <span className="truncate text-sm text-fg-faint">{row.lastLine}</span>
          </span>
        </span>
      </button>
      <div className="pointer-events-none absolute top-2 right-2 bottom-2 flex flex-col items-end justify-between">
        <div className="grid">
          <span className="col-start-1 row-start-1 self-center font-mono text-2xs text-fg-faint tabular-nums group-focus-within:invisible group-hover:invisible group-has-[[aria-expanded=true]]:invisible">
            {shortAgo(row.lastAt, now)}
          </span>
          <div className="pointer-events-auto invisible col-start-1 row-start-1 group-focus-within:visible group-hover:visible group-has-[[aria-expanded=true]]:visible">
            <Menu
              label={`Options for ${title}`}
              items={items}
              trigger={(props) => (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Options for ${title}`}
                  className="size-5"
                  {...props}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              )}
            />
          </div>
        </div>
        {unread > 0 && (
          <span
            role="img"
            aria-label={`${unread} unread`}
            className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 font-mono text-2xs font-semibold text-accent-ink tabular-nums"
          >
            {badgeText(unread)}
          </span>
        )}
      </div>
    </div>
  );
}

/** The row menu: Mark as read, Archive, Unlink and Delete (client chats), Delete (agent chats). */
function useRowActions(onDeleted: ((id: string) => void) | undefined) {
  const toast = useToast();
  const archive = useArchiveConversation();
  const read = useMarkConversationRead();
  const unlink = useUnlinkChat();
  const remove = useRemoveTask();
  const [deleting, setDeleting] = useState<Conversation>();
  const fail = (what: string) => (error: unknown) =>
    toast(what, { detail: describeError(error), tone: "error" });

  const items = (row: Conversation): MenuItem[] => {
    const out: MenuItem[] = [
      {
        label: "Mark as read",
        disabled: row.unread === 0,
        onSelect: () =>
          read.mutate({ id: row.id, upTo: row.lastAt }, { onError: fail("Could not mark it read") }),
      },
      {
        label: row.archived === true ? "Unarchive" : "Archive",
        onSelect: () =>
          archive.mutate(
            { id: row.id, archived: row.archived !== true },
            { onError: fail("Could not archive it") },
          ),
      },
    ];
    if (row.kind === "client" && row.unlinked !== true) {
      out.push({
        label: "Unlink",
        onSelect: () => unlink.mutate({ room: row.id }, { onError: fail("Could not unlink the chat") }),
      });
    }
    if (row.kind === "agent" || row.kind === "client") {
      out.push({ label: "Delete", tone: "danger", onSelect: () => setDeleting(row) });
    }
    return out;
  };

  const dialog = deleting && (
    <ConfirmDialog
      title="Delete this chat?"
      body={
        deleting.kind === "client"
          ? `"${chatTitle(deleting)}" and its messages are removed from majhi only. Nothing is deleted in ${deleting.app === undefined ? "the chat app" : CHAT_APP_LABEL[deleting.app]}, and replies waiting for you are discarded. A new message from the chat shows up again under New chats.`
          : `"${chatTitle(deleting)}" and its messages are removed. Tasks the agent made stay.`
      }
      confirmLabel="Delete"
      busy={remove.isPending}
      error={remove.isError ? describeError(remove.error) : undefined}
      onConfirm={() => {
        const id = deleting.id;
        remove.mutate(
          { id },
          {
            onSuccess: () => {
              setDeleting(undefined);
              onDeleted?.(id);
            },
          },
        );
      }}
      onCancel={() => {
        remove.reset();
        setDeleting(undefined);
      }}
    />
  );
  return { items, dialog };
}
