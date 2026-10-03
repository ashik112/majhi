import type { CaptainOrg } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, History, RotateCcw, SquarePen } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Lamp } from "@/components/ui/lamp";
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
import { formatAgo, formatMoney } from "@/lib/format";
import { useChats } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { orgOfTab, threadsOf, validTab, waitingWord, wsTab } from "./panel-model";

/** Today's spend of a thread's workspace against its budget: "$3.10 of $20 today". */
function spendWord(org: CaptainOrg): string {
  const cost = org.budget?.cost;
  const used = formatMoney(org.used.cost);
  if (cost === undefined) return `${used} today`;
  return `${used} of ${Number.isInteger(cost) ? `$${cost}` : formatMoney(cost)} today`;
}

/** A chip for the conversation: All, or one workspace. The dot shows only when that thread waits on the owner. */
function Chip({
  label,
  selected,
  waiting,
  hint,
  onSelect,
}: {
  label: string;
  selected: boolean;
  waiting?: boolean;
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
        "flex h-8 max-w-[170px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors",
        selected
          ? "border-accent-line bg-accent-wash font-medium text-fg"
          : "border-line-strong bg-card text-fg-muted hover:border-line-hover hover:text-fg",
      )}
    >
      <span className="truncate">{label}</span>
      {waiting && (
        <>
          <Lamp state="needs" size={7} />
          <span className="sr-only">(waiting on you)</span>
        </>
      )}
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
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-2.5", className)}>
      <fieldset
        aria-label="Talk to"
        className="m-0 -mx-1 flex min-w-0 shrink-0 gap-1.5 overflow-x-auto border-0 px-1 pt-0 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
            waiting={t.thread === "waiting"}
            hint={t.thread === "waiting" ? waitingWord(t) : `The captain's thread in ${t.name}`}
            onSelect={() => setTab(wsTab(t.org))}
          />
        ))}
      </fieldset>
      {current === undefined ? <Talk /> : <Thread key={current.org} org={current} />}
    </div>
  );
}

/** The owner's own chat with the captain: new chat, earlier chats, and the conversation. */
function Talk() {
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
      <div className="flex shrink-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-faint">
          {boss ? `@${boss}` : ""}
        </span>
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
            size="icon-sm"
            title="Open in Chats"
            aria-label="Open this chat in Chats"
            onClick={() => {
              hide();
              void navigate({ to: "/chats/$taskId", params: { taskId: chat.data.id } });
            }}
          >
            <ExternalLink aria-hidden="true" />
          </Button>
        )}
      </div>
      <BossConversation />
    </>
  );
}

const THREAD_WORD = { working: "Working", waiting: "Waiting on you", idle: "Idle" } as const;
const THREAD_LAMP = { working: "working", waiting: "needs", idle: "idle" } as const;

/** One workspace's thread: its state, today's spend, Start fresh, the conversation and the box. */
function Thread({ org }: { org: CaptainOrg }) {
  const toast = useToast();
  const autonomyStatus = useAutonomyStatus().data;
  const fresh = useStartFresh();
  const [asking, setAsking] = useState(false);
  const lane = org.lane;
  if (lane === undefined) return null;
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5 text-sm">
          <Lamp state={THREAD_LAMP[org.thread]} size={7} />
          <span className={org.thread === "idle" ? "text-fg-faint" : "text-fg"}>
            {THREAD_WORD[org.thread]}
          </span>
        </span>
        <span
          title="Spent by the captain and its tasks in this workspace today"
          className="tnum text-sm text-fg-muted"
        >
          {spendWord(org)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          title="End this thread's session and start a new one with a short summary"
          onClick={() => setAsking(true)}
        >
          <RotateCcw aria-hidden="true" />
          Start fresh
        </Button>
      </div>
      {org.resting !== undefined && (
        <p className="shrink-0 rounded-md border border-amber-line bg-amber-wash px-3 py-1.5 text-sm text-amber text-pretty">
          {org.resting}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-raised/40">
        <ChatLog chat={lane} />
        {autonomyStatus ? (
          <ChatBox status={autonomyStatus} lane={org.org} />
        ) : (
          <div className="p-3">
            <RowsSkeleton rows={1} height={72} />
          </div>
        )}
      </div>
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
