import type { Conversation } from "@majhi/shared";
import { PAGE_PATH } from "@majhi/shared";
import { useNavigate, useParams } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { AccountNotices, NewChats } from "@/features/clients/clients-list";
import { useChatFilter } from "@/lib/chat-filter";
import { useNewChat } from "@/lib/chat-queries";
import { useClients } from "@/lib/client-queries";
import { cn } from "@/lib/cn";
import { useConversations } from "@/lib/conversation-queries";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import { ChatView } from "./chat-view";
import { ConversationList } from "./conversation-list";
import { WorkspaceTabs } from "./workspace-tabs";

/** `/chats` and `/chats/<id>`: workspace tabs on top, the one list of conversations on the left, the chat on the right. */
export function ChatsScreen() {
  const { taskId } = useParams({ strict: false }) as { taskId?: string };
  const navigate = useNavigate();
  const toast = useToast();
  const agents = useAgents();
  const orgs = useOrgs();
  const list = useConversations();
  const clients = useClients();
  const filter = useChatFilter();
  const newChat = useNewChat();
  const [renaming, setRenaming] = useState<string>();

  const boss = (agents.data ?? []).find((e) => e.status === "ok" && e.isBoss);
  const bossId = boss?.status === "ok" ? boss.agent.frontmatter.id : undefined;

  function openChat(id: string) {
    void navigate({ to: "/chats/$taskId", params: { taskId: id } });
  }
  function open(row: Conversation) {
    if (row.kind === "task") void navigate({ to: "/t/$taskId", params: { taskId: row.id } });
    else if (row.kind === "captain") {
      void navigate({ to: PAGE_PATH.captain, search: row.org === undefined ? {} : { thread: row.org } });
    } else openChat(row.id);
  }
  function start(agent: string) {
    newChat.mutate(agent, {
      onSuccess: (task) => openChat(task.id),
      onError: (error) => toast("Could not start the chat", { detail: describeError(error), tone: "error" }),
    });
  }
  const showNew =
    filter.tab === "all" && !filter.archived && (filter.kind === "all" || filter.kind === "client");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkspaceTabs list={list.data ?? []} orgs={orgs.data} className="mb-2" />
      <div className="flex min-h-0 min-w-0 flex-1 gap-3">
        <nav
          aria-label="Chats"
          className={cn(
            "flex w-[264px] shrink-0 flex-col overflow-hidden rounded-2xl min-[1320px]:w-[296px]",
            GLASS,
          )}
        >
          <ConversationList
            selected={taskId}
            onOpen={open}
            onNewChat={openChat}
            onDeleted={(id) => {
              if (taskId === id) void navigate({ to: "/chats" });
            }}
            top={
              showNew
                ? (query: string) => (
                    <>
                      <NewChats
                        rows={(clients.data?.newChats ?? []).filter((r) =>
                          r.title.toLowerCase().includes(query.trim().toLowerCase()),
                        )}
                        orgs={orgs.data ?? []}
                      />
                      <AccountNotices accounts={clients.data?.accounts ?? []} />
                    </>
                  )
                : undefined
            }
            newChats={clients.data?.newChats ?? []}
          />
        </nav>
        <section aria-label="Chat" className="flex min-h-0 min-w-0 flex-1 flex-col pr-1">
          {taskId ? (
            <ChatView
              key={taskId}
              taskId={taskId}
              renaming={renaming === taskId}
              onRename={() => setRenaming(taskId)}
              onRenamed={() => setRenaming(undefined)}
              onNew={start}
              creating={newChat.isPending}
            />
          ) : (
            <div className="m-auto flex max-w-[360px] flex-col items-center gap-3 text-center">
              <MessagesSquare aria-hidden="true" className="size-6 text-fg-faint" />
              <h1 className="text-md font-semibold">Chat with an agent</h1>
              <p className="text-base text-fg-muted text-pretty">
                Pick a chat on the left, or start one. A chat is just a conversation. The agent can make a
                task when you ask for one.
              </p>
              {bossId !== undefined && (
                <Button variant="primary" disabled={newChat.isPending} onClick={() => start(bossId)}>
                  <AgentAvatar id={bossId} size={18} decorative />
                  Chat with @{bossId}
                </Button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
