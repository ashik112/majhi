import type { CaptainOrg } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { History, RotateCcw, SquarePen } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Menu } from "@/components/ui/menu";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ChatBox, ChatLog } from "@/features/autonomy/guide";
import { BossConversation } from "@/features/boss/boss-conversation";
import { chatTitle } from "@/features/chats/model";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { useBossChat, useNewBossChat } from "@/lib/boss-queries";
import { useCaptainStatus, useStartFresh } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { useChats } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";

/**
 * The conversation with the captain. One conversation: with a workspace picked in the top bar it is the
 * captain's step in that workspace, scoped to it; with All it is the owner's own chat, where the captain reads
 * across workspaces and acts in one workspace at a time. What the captain did between messages folds into one
 * line per turn.
 */
export function Conversation({ className }: { className?: string }) {
  const { org } = useOrgFilter();
  const status = useCaptainStatus().data;
  const current = org === undefined ? undefined : status?.orgs.find((t) => t.org === org);
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 border-b border-line px-3 py-2">
        <span className="mr-auto truncate text-sm text-fg-muted">
          {current === undefined ? "All workspaces" : `Scoped to ${current.name}`}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {current === undefined ? <TalkActions /> : <ThreadActions org={current} />}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        {current === undefined ? <BossConversation /> : <Thread key={org} org={current} />}
      </div>
    </div>
  );
}

/** The owner's own chat: new chat, earlier chats and Open in Chats. */
function TalkActions() {
  const chat = useBossChat();
  const fresh = useNewBossChat();
  const chats = useChats();
  const navigate = useNavigate();
  const now = useNow(60_000);
  const boss = chat.data?.team[0];
  const past = (chats.data ?? [])
    .filter((t) => t.id !== chat.data?.id && t.team[0] === boss && t.org === undefined)
    .slice(0, 15);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={fresh.isPending || !chat.data}
        onClick={() => fresh.mutate()}
        title="Start a new conversation. This one stays in the chat list"
      >
        <SquarePen aria-hidden="true" />
        New chat
      </Button>
      {past.length > 0 && (
        <Menu
          label="Past chats"
          icon={<History aria-hidden="true" />}
          items={[
            ...past.map((t) => ({
              label: `${chatTitle(t)} · ${formatAgo(t.updatedAt, now)}`,
              onSelect: () => void navigate({ to: "/", search: { chat: t.id } }),
            })),
          ]}
        />
      )}
    </>
  );
}

/** One workspace's thread: Start fresh, with its confirmation. */
function ThreadActions({ org }: { org: CaptainOrg }) {
  const toast = useToast();
  const fresh = useStartFresh();
  const [asking, setAsking] = useState(false);
  if (org.lane === undefined) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        title="End this thread's session and start a new one with a short summary"
        onClick={() => setAsking(true)}
      >
        <RotateCcw aria-hidden="true" />
        Start fresh
      </Button>
      {asking && (
        <ConfirmDialog
          title={`Start fresh in ${org.name}?`}
          body="The captain begins a new session here, with a short summary of this one. The messages stay in the thread."
          confirmLabel="Start fresh"
          busy={fresh.isPending}
          error={fresh.error ? describeError(fresh.error) : undefined}
          onConfirm={() =>
            fresh.mutate(
              { org: org.org, name: org.name, urgent: false },
              {
                onSuccess: () => {
                  setAsking(false);
                  toast(`Started fresh in ${org.name}`);
                },
              },
            )
          }
          onCancel={() => {
            fresh.reset();
            setAsking(false);
          }}
        />
      )}
    </>
  );
}

/** One workspace's thread: the conversation and the box. */
export function Thread({ org }: { org: CaptainOrg }) {
  const autonomyStatus = useAutonomyStatus().data;
  // One thread: the workspace's sessions read as one, and a message goes to its backlog session.
  const lane = org.lane ?? org.onCall;
  return (
    <>
      {org.resting !== undefined && (
        <p className="shrink-0 rounded-md border border-amber-line bg-amber-wash px-3 py-1.5 text-sm text-amber text-pretty">
          {org.resting}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-raised/40">
        {lane === undefined ? (
          <p className="flex flex-1 items-center justify-center px-6 text-center text-sm text-fg-muted text-pretty">
            No thread in {org.name} yet. Your first message opens it. The captain reads only {org.name} there,
            and what it may do follows that workspace's Permissions.
          </p>
        ) : (
          <ChatLog chat={lane} />
        )}
        {autonomyStatus ? (
          <ChatBox status={autonomyStatus} lane={org.org} chat={lane} />
        ) : (
          <div className="p-3">
            <RowsSkeleton rows={1} height={72} />
          </div>
        )}
      </div>
    </>
  );
}
