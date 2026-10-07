import type { ClientList, OrgView, TaskSummary } from "@majhi/shared";
import { ChevronRight, MoreHorizontal, Search, SquarePen } from "lucide-react";
import { useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lamp } from "@/components/ui/lamp";
import { ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { Menu } from "@/components/ui/menu";
import { OrgBadge } from "@/components/ui/org-badge";
import { AccountNotices, ClientRows, NewChats } from "@/features/clients/clients-list";
import { cn } from "@/lib/cn";
import { badgeLetters, formatAgo } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { type ChatAgentRow, type ChatGroup, chatTitle } from "./model";

const SHOWN = 6;

/** The left column: a search box, then agents by org, each opening to its chats. */
export function ChatList({
  groups,
  orgKeys,
  selected,
  query,
  onQuery,
  onOpen,
  onNew,
  onRename,
  onDelete,
  creating,
  now,
  clients,
  orgs,
}: {
  /** The clients' chats, and the chats nobody linked yet. */
  clients: ClientList | undefined;
  orgs: readonly OrgView[];
  groups: readonly ChatGroup[];
  orgKeys: ReadonlyMap<string, { key: string; color: string | undefined }>;
  selected: string | undefined;
  query: string;
  onQuery: (value: string) => void;
  onOpen: (chat: string) => void;
  onNew: (agent: string) => void;
  onRename: (chat: TaskSummary) => void;
  onDelete: (chat: TaskSummary) => void;
  /** The agent a chat is being made for. */
  creating: string | undefined;
  now: number;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const selectedAgent = groups
    .flatMap((g) => g.agents)
    .find((a) => a.chats.some((c) => c.id === selected))?.id;
  return (
    <nav
      aria-label="Chats"
      className={cn(
        "flex w-[264px] shrink-0 flex-col overflow-hidden rounded-2xl min-[1320px]:w-[296px]",
        GLASS,
      )}
    >
      <div className="shrink-0 border-b border-line p-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-faint"
          />
          <Input
            type="search"
            aria-label="Search chats"
            placeholder="Search chats"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            className="pl-8"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-6 scroll-fade">
        <NewChats rows={clients?.newChats ?? []} orgs={orgs} />
        <AccountNotices accounts={clients?.accounts ?? []} />
        {groups.length === 0 && (
          <p className="px-2 py-3 text-sm text-fg-faint">
            {query.trim() === "" ? "No agents yet. Make one in Agents." : "Nothing matches."}
          </p>
        )}
        <div className="flex flex-col gap-3">
          {groups.map(({ group, agents }) => {
            const org = orgKeys.get(group.scope);
            return (
              <section key={group.scope} aria-label={group.label} className="flex flex-col gap-px">
                <div className="flex h-7 items-center gap-2 pl-2">
                  <OrgBadge
                    label={group.scope === "root" ? "R" : badgeLetters(org?.key ?? group.label)}
                    color={group.scope === "root" ? "var(--c-green)" : org?.color}
                    size="xs"
                  />
                  <h2 className="min-w-0 truncate text-sm font-medium text-fg-soft">{group.label}</h2>
                </div>
                <ClientRows
                  rows={(clients?.clients ?? []).filter(
                    (c) =>
                      c.org === group.scope &&
                      (query.trim() === "" || c.title.toLowerCase().includes(query.trim().toLowerCase())),
                  )}
                  selected={selected}
                  onOpen={onOpen}
                />
                {agents.length === 0 && <p className="px-2 pb-1 text-sm text-fg-faint">No agents yet.</p>}
                {agents.map((agent) => (
                  <AgentBlock
                    key={agent.id}
                    agent={agent}
                    expanded={
                      query.trim() !== "" ||
                      (open[agent.id] ?? (agent.id === selectedAgent || agent.entry.isBoss))
                    }
                    onToggle={() =>
                      setOpen((prev) => ({
                        ...prev,
                        [agent.id]: !(prev[agent.id] ?? (agent.id === selectedAgent || agent.entry.isBoss)),
                      }))
                    }
                    selected={selected}
                    onOpen={onOpen}
                    onNew={onNew}
                    onRename={onRename}
                    onDelete={onDelete}
                    creating={creating === agent.id}
                    now={now}
                    searching={query.trim() !== ""}
                    workspace={group.label}
                  />
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

function AgentBlock({
  agent,
  expanded,
  onToggle,
  selected,
  onOpen,
  onNew,
  onRename,
  onDelete,
  creating,
  now,
  searching,
  workspace,
}: {
  agent: ChatAgentRow;
  workspace: string;
  expanded: boolean;
  onToggle: () => void;
  selected: string | undefined;
  onOpen: (chat: string) => void;
  onNew: (agent: string) => void;
  onRename: (chat: TaskSummary) => void;
  onDelete: (chat: TaskSummary) => void;
  creating: boolean;
  now: number;
  searching: boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = all || searching ? agent.chats : agent.chats.slice(0, SHOWN);
  return (
    <div className="flex flex-col gap-px">
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className={cn(ROW, "h-8 min-w-0 flex-1 items-center gap-2 pr-1.5 pl-1.5")}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("size-3 shrink-0 text-fg-faint transition-transform", expanded && "rotate-90")}
          />
          <AgentAvatar id={agent.id} size={20} decorative />
          <span className="min-w-0 truncate font-mono text-sm text-fg-soft">@{agent.id}</span>
          {agent.entry.isBoss && <span className="shrink-0 text-xs text-fg-faint">captain</span>}
          {agent.asking && (
            <>
              <Lamp state="needs" size={6} className="ml-auto shrink-0" />
              <span className="sr-only">Waits for you</span>
            </>
          )}
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`New chat with @${agent.id}`}
          title={`New chat with @${agent.id}`}
          disabled={creating}
          onClick={() => onNew(agent.id)}
          className="text-fg-faint hover:text-fg"
        >
          <SquarePen aria-hidden="true" />
        </Button>
      </div>
      {expanded && (
        <ul className="ml-[18px] flex flex-col gap-px border-l border-line pl-1.5">
          {agent.chats.length === 0 && <li className="px-2 py-1 text-sm text-fg-faint">No chats yet.</li>}
          {shown.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              active={chat.id === selected}
              onOpen={() => onOpen(chat.id)}
              onRename={() => onRename(chat)}
              onDelete={() => onDelete(chat)}
              agent={agent.id}
              workspace={workspace}
              now={now}
            />
          ))}
          {!all && !searching && agent.chats.length > SHOWN && (
            <li>
              <button
                type="button"
                onClick={() => setAll(true)}
                className="h-7 w-full rounded-md px-2 text-left text-sm text-fg-faint hover:bg-raised hover:text-fg"
              >
                Show {agent.chats.length - SHOWN} more
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function ChatRow({
  chat,
  active,
  onOpen,
  onRename,
  onDelete,
  agent,
  workspace,
  now,
}: {
  agent: string;
  workspace: string;
  chat: TaskSummary;
  active: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  now: number;
}) {
  const title = chatTitle(chat);
  return (
    <li className="group relative">
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        title={`${title} · @${agent} · ${workspace} · ${formatAgo(chat.updatedAt, now)}`}
        onClick={onOpen}
        className={cn(
          ROW,
          "min-h-[38px] flex-col justify-center gap-px px-2 py-1 pr-8",
          active && ROW_SELECTED,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("min-w-0 truncate text-base", active ? "text-fg" : "text-fg-soft")}>
            {title}
          </span>
          {chat.asking === true && (
            <>
              <Lamp state="needs" size={6} className="shrink-0" />
              <span className="sr-only">Waits for you</span>
            </>
          )}
          {chat.working.length > 0 && <Lamp state="working" size={6} className="shrink-0" />}
        </span>
        <span className="text-xs text-fg-faint">{formatAgo(chat.updatedAt, now)}</span>
      </button>
      <div className="absolute top-1.5 right-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100">
        <Menu
          label={`Options for ${title}`}
          trigger={(props) => (
            <Button variant="ghost" size="icon-sm" aria-label={`Options for ${title}`} {...props}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          )}
          items={[
            { label: "Rename", onSelect: onRename },
            { label: "Delete", onSelect: onDelete, tone: "danger" },
          ]}
        />
      </div>
    </li>
  );
}
