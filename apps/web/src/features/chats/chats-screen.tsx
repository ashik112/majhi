import type { TaskSummary } from "@majhi/shared";
import { useNavigate, useParams } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useNewChat } from "@/lib/chat-queries";
import { describeError } from "@/lib/errors";
import { useOrgFilter } from "@/lib/org-filter";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import { useChats, useRemoveTask } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { ChatList } from "./chat-list";
import { ChatView } from "./chat-view";
import { chatGroups, chatTitle } from "./model";

/** `/chats` and `/chats/<id>`: talk to any agent without making a task. Agents by org on the left, the chat on the right. */
export function ChatsScreen() {
  const { taskId } = useParams({ strict: false }) as { taskId?: string };
  const navigate = useNavigate();
  const toast = useToast();
  const agents = useAgents();
  const orgs = useOrgs();
  const chats = useChats();
  const { org } = useOrgFilter();
  const now = useNow(60_000);
  const newChat = useNewChat();
  const remove = useRemoveTask();
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string>();
  const [deleting, setDeleting] = useState<TaskSummary>();

  const entries = useMemo(() => agents.data ?? [], [agents.data]);
  const orgList = useMemo(() => orgs.data ?? [], [orgs.data]);
  const groups = useMemo(
    () => chatGroups({ entries, orgs: orgList, chats: chats.data ?? [], org, query }),
    [entries, orgList, chats.data, org, query],
  );
  const orgKeys = useMemo(
    () => new Map(orgList.map((o) => [o.id, { key: o.key, color: o.color }])),
    [orgList],
  );
  const boss = entries.find((e) => e.status === "ok" && e.isBoss);
  const bossId = boss?.status === "ok" ? boss.agent.frontmatter.id : undefined;

  function open(id: string) {
    void navigate({ to: "/chats/$taskId", params: { taskId: id } });
  }
  function start(agent: string) {
    newChat.mutate(agent, {
      onSuccess: (task) => open(task.id),
      onError: (error) => toast("Could not start the chat", { detail: describeError(error), tone: "error" }),
    });
  }
  function confirmDelete() {
    if (!deleting) return;
    const id = deleting.id;
    remove.mutate(
      { id },
      {
        onSuccess: () => {
          setDeleting(undefined);
          if (taskId === id) void navigate({ to: "/chats" });
        },
      },
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-3">
      <ChatList
        groups={groups}
        orgKeys={orgKeys}
        selected={taskId}
        query={query}
        onQuery={setQuery}
        onOpen={open}
        onNew={start}
        onRename={(chat) => {
          setRenaming(chat.id);
          if (chat.id !== taskId) open(chat.id);
        }}
        onDelete={setDeleting}
        creating={newChat.isPending ? newChat.variables : undefined}
        now={now}
      />
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
              Pick a chat on the left, or start one. A chat is just a conversation. The agent can make a task
              when you ask for one.
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
      {deleting && (
        <ConfirmDialog
          title="Delete this chat?"
          body={`"${chatTitle(deleting)}" and its messages are removed. Tasks the agent made stay.`}
          confirmLabel="Delete"
          busy={remove.isPending}
          error={remove.isError ? describeError(remove.error) : undefined}
          onConfirm={confirmDelete}
          onCancel={() => {
            remove.reset();
            setDeleting(undefined);
          }}
        />
      )}
    </div>
  );
}
