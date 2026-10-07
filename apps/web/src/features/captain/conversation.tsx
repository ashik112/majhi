import type { CaptainOrg } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, History, RotateCcw, SquarePen } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { Menu } from "@/components/ui/menu";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ChatBox, ChatLog } from "@/features/autonomy/guide";
import { useBoss } from "@/features/boss/boss-context";
import { BossConversation } from "@/features/boss/boss-conversation";
import { chatTitle } from "@/features/chats/model";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { useBossChat, useNewBossChat } from "@/lib/boss-queries";
import { useCaptainStatus, useStartFresh } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useChats } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { orgOfTab, threadsOf, validTab, waitingWord, wsTab } from "./panel-model";

/** A chip for the conversation: All, or one workspace. The dot shows only when that thread waits on the owner. */
function Chip({
  label,
  selected,
  lamp,
  hint,
  onSelect,
}: {
  label: string;
  selected: boolean;
  lamp?: LampState | undefined;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={hint}
      onClick={onSelect}
      className={cn(
        "flex h-7 max-w-[170px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition-colors",
        selected
          ? "border-accent-line bg-accent-wash text-fg"
          : "border-line-control text-fg-muted hover:border-line-hover hover:text-fg",
      )}
    >
      {lamp && <Lamp state={lamp} size={6} />}
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * The one conversation with the captain, on the Captain page and in the Cmd J drawer. Chips pick
 * where a message goes: All is the owner's own chat, each workspace is the captain's thread there.
 * What the captain did between messages folds into one line per turn.
 */
export function Conversation({ className }: { className?: string }) {
  const { tab: asked, setTab } = useBoss();
  const status = useCaptainStatus().data;
  const threads = useMemo(() => threadsOf(status?.orgs ?? []), [status?.orgs]);
  const tab = validTab(asked, threads);
  const org = orgOfTab(tab);
  const current = org === undefined ? undefined : threads.find((t) => t.org === org);
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2">
        <fieldset
          aria-label="Talk to"
          className="m-0 flex min-w-[220px] flex-1 gap-1.5 overflow-x-auto border-0 p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <Chip
            label="All"
            selected={tab === "talk"}
            hint="Your own chat with the captain"
            onSelect={() => setTab("talk")}
          />
          {threads.map((t) => (
            <Chip
              key={t.org}
              label={t.name}
              selected={tab === wsTab(t.org)}
              lamp={t.thread === "idle" ? undefined : THREAD_LAMP[t.thread]}
              hint={t.thread === "waiting" ? waitingWord(t) : `The captain's thread in ${t.name}`}
              onSelect={() => setTab(wsTab(t.org))}
            />
          ))}
        </fieldset>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {current === undefined ? <TalkActions /> : <ThreadActions org={current} />}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        {current === undefined ? <BossConversation /> : <Thread key={current.org} org={current} />}
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
  const { hide } = useBoss();
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
        title="Start a new conversation. This one stays in Chats"
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
              onSelect: () => {
                hide();
                void navigate({ to: "/chats/$taskId", params: { taskId: t.id } });
              },
            })),
            {
              label: "All chats",
              onSelect: () => {
                hide();
                void navigate({ to: "/chats" });
              },
            },
          ]}
        />
      )}
      {chat.data && (
        <Button
          variant="ghost"
          size="sm"
          title="Open this chat in Chats"
          onClick={() => {
            hide();
            void navigate({ to: "/chats/$taskId", params: { taskId: chat.data.id } });
          }}
        >
          <ExternalLink aria-hidden="true" />
          Open in Chats
        </Button>
      )}
    </>
  );
}

const THREAD_LAMP = { working: "working", waiting: "needs", idle: "idle" } as const;

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
              { org: org.org, name: org.name },
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
  const lane = org.lane;
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
