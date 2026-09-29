import { Link, useNavigate } from "@tanstack/react-router";
import { ExternalLink, History, SquarePen, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Menu } from "@/components/ui/menu";
import { isBossChat } from "@/features/board/model";
import { useBossChat, useNewBossChat } from "@/lib/boss-queries";
import { MOD_KEY } from "@/lib/format";
import { useTasks } from "@/lib/task-queries";
import { useBoss } from "./boss-context";
import { BossConversation } from "./boss-conversation";

/** The boss chat as a right-side drawer over any page. Cmd+J or the sidebar opens it. */
export function BossDrawer() {
  const { open, hide } = useBoss();
  const chat = useBossChat(open);
  const fresh = useNewBossChat();
  const tasks = useTasks(open);
  const navigate = useNavigate();
  const panel = useRef<HTMLElement>(null);

  // Focus moves into the drawer when it opens, and again when the chat loads (its field appears then).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the field exists only after the chat loaded
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("textarea")?.focus();
  }, [open, chat.data?.id]);

  if (!open) return null;
  const boss = chat.data?.team[0];
  // Earlier conversations with this boss, newest first: archived by "New chat", readable as tasks.
  const past = (tasks.data ?? [])
    .filter((t) => t.id !== chat.data?.id && t.status === "done" && isBossChat(t, boss))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 15);
  return (
    <aside
      ref={panel}
      aria-label="Boss chat"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) hide();
      }}
      className="fixed inset-y-0 right-0 z-40 flex w-[min(480px,100vw)] animate-fade-in flex-col gap-3 border-l border-line-strong bg-canvas p-4 shadow-pop"
    >
      <header className="flex items-center gap-2.5">
        {boss && <AgentAvatar id={boss} size={28} />}
        <div className="flex min-w-0 flex-col">
          <h2 className="text-md font-semibold">Boss</h2>
          {boss && <span className="truncate font-mono text-xs text-fg-faint">@{boss}</span>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={fresh.isPending || !chat.data}
            onClick={() => fresh.mutate()}
            title="Archive this conversation and start a new one"
          >
            <SquarePen aria-hidden="true" />
            New chat
          </Button>
          {past.length > 0 && (
            <Menu
              label="Past chats"
              icon={<History aria-hidden="true" />}
              items={past.map((t) => ({
                label: `${t.id} · ${new Date(t.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`,
                onSelect: () => {
                  hide();
                  void navigate({ to: "/t/$taskId", params: { taskId: t.id } });
                },
              }))}
            />
          )}
          {chat.data && (
            <Button asChild variant="ghost" size="icon-sm" title="Open as a task">
              <Link
                to="/t/$taskId"
                params={{ taskId: chat.data.id }}
                onClick={hide}
                aria-label="Open the boss chat as a task"
              >
                <ExternalLink aria-hidden="true" />
              </Link>
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Close the boss chat" onClick={hide}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>
      <BossConversation />
      <p className="text-xs text-fg-faint">
        <Kbd>{MOD_KEY} J</Kbd> opens and closes this. Changes wait for your approval.
      </p>
    </aside>
  );
}
