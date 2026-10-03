import type { CaptainOrg } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, History, RotateCcw, SquarePen } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { Menu } from "@/components/ui/menu";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ChatBox, ChatLog } from "@/features/autonomy/guide";
import { type PanelTab, useBoss } from "@/features/boss/boss-context";
import { BossConversation } from "@/features/boss/boss-conversation";
import { chatTitle } from "@/features/chats/model";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { useBossChat, useNewBossChat } from "@/lib/boss-queries";
import { useCaptainStatus, useStartFresh, useThreadItems } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo, formatMoney } from "@/lib/format";
import { useChats } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import {
  mergeThreads,
  orgOfTab,
  stepTab,
  THREAD_LAMP,
  THREAD_WORD,
  threadsOf,
  validTab,
  wsTab,
} from "./panel-model";

/** Today's spend of a thread's workspace against its budget: "$3.10 of $20 today". */
function spendWord(org: CaptainOrg): string {
  const cost = org.budget?.cost;
  const used = formatMoney(org.used.cost);
  if (cost === undefined) return `${used} today`;
  return `${used} of ${Number.isInteger(cost) ? `$${cost}` : formatMoney(cost)} today`;
}

/**
 * The Captain panel, in the Cmd J drawer and on the Captain page: a tab for talking to the captain,
 * one for every workspace thread merged, and one thread per workspace. Arrow keys move between
 * tabs. The threads are the captain's own: they are not tasks, so they have no delete, only Start fresh.
 */
export function CaptainPanel({ className }: { className?: string }) {
  const { tab: asked, setTab } = useBoss();
  const query = useCaptainStatus();
  const status = query.data;
  const threads = useMemo(() => threadsOf(status?.orgs ?? []), [status?.orgs]);
  const tab = validTab(asked, threads);
  const tabs: PanelTab[] = useMemo(() => ["talk", "all", ...threads.map((t) => wsTab(t.org))], [threads]);
  const refs = useRef(new Map<PanelTab, HTMLButtonElement>());

  // The selected tab stays in view when there are more of them than the strip holds.
  useEffect(() => {
    refs.current.get(tab)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  function onKeyDown(event: KeyboardEvent) {
    const next = stepTab(tabs, tab, event.key);
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    refs.current.get(next)?.focus();
  }

  const anyWaiting = threads.some((t) => t.thread === "waiting");
  const org = orgOfTab(tab);
  const current = org === undefined ? undefined : threads.find((t) => t.org === org);

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-3", className)}>
      <div
        role="tablist"
        aria-label="Captain"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <TabButton
          id="talk"
          label="Talk"
          selected={tab === "talk"}
          onSelect={() => setTab("talk")}
          refs={refs.current}
        />
        <TabButton
          id="all"
          label="All"
          lamp={anyWaiting ? "needs" : undefined}
          selected={tab === "all"}
          onSelect={() => setTab("all")}
          refs={refs.current}
        />
        {threads.map((t) => (
          <TabButton
            key={t.org}
            id={wsTab(t.org)}
            label={t.name}
            lamp={THREAD_LAMP[t.thread]}
            hint={`${t.name}: ${THREAD_WORD[t.thread]}`}
            selected={tab === wsTab(t.org)}
            onSelect={() => setTab(wsTab(t.org))}
            refs={refs.current}
          />
        ))}
      </div>
      <div
        role="tabpanel"
        aria-label={current?.name ?? (tab === "all" ? "All threads" : "Talk")}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
      >
        {tab === "talk" && <TalkTab />}
        {tab === "all" && (
          <AllTab
            loading={query.isPending}
            error={query.isError ? describeError(query.error) : undefined}
            threads={threads}
            noCaptain={status !== undefined && status.captain === undefined}
            onPick={(o) => setTab(wsTab(o))}
          />
        )}
        {current && <ThreadTab key={current.org} org={current} autonomy={status?.autonomy ?? "off"} />}
      </div>
    </div>
  );
}

function TabButton({
  id,
  label,
  lamp,
  hint,
  selected,
  onSelect,
  refs,
}: {
  id: PanelTab;
  label: string;
  lamp?: LampState | undefined;
  hint?: string;
  selected: boolean;
  onSelect: () => void;
  refs: Map<PanelTab, HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      title={hint ?? label}
      ref={(el) => {
        if (el) refs.set(id, el);
        else refs.delete(id);
      }}
      onClick={onSelect}
      className={cn(
        "flex h-8 max-w-[160px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-base transition-colors",
        selected
          ? "border-line-control bg-selected font-medium text-fg"
          : "border-transparent text-fg-muted hover:bg-raised hover:text-fg",
      )}
    >
      {lamp && <Lamp state={lamp} size={7} />}
      <span className="truncate">{label}</span>
      {lamp === "needs" && <span className="sr-only"> (waiting on you)</span>}
    </button>
  );
}

/** The owner's own chat with the captain: new chat, earlier chats, and the conversation. */
function TalkTab() {
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

/** Every thread's messages, newest first, each labelled by its workspace. */
function AllTab({
  loading,
  error,
  threads,
  noCaptain,
  onPick,
}: {
  loading: boolean;
  error: string | undefined;
  threads: readonly CaptainOrg[];
  noCaptain: boolean;
  onPick: (org: string) => void;
}) {
  const now = useNow(30_000);
  const chats = threads.flatMap((t) => (t.lane === undefined ? [] : [{ org: t.org, chat: t.lane }]));
  const results = useThreadItems(chats, true);
  const names = new Map(threads.map((t) => [t.org, t.name]));
  const lines = mergeThreads(
    results.map((r, i) => ({ org: chats[i]?.org ?? "", items: r.data?.items ?? [] })),
  );
  if (error !== undefined) return <PanelNote title="Could not reach majhi" body={error} />;
  if (loading) return <RowsSkeleton rows={4} height={56} />;
  if (noCaptain)
    return (
      <PanelNote
        title="There is no captain yet"
        body={
          <>
            Choose one on the{" "}
            <PageLink page="agents" className="text-blue hover:underline">
              Agents page
            </PageLink>
            .
          </>
        }
      />
    );
  if (threads.length === 0)
    return (
      <PanelNote
        title="No workspace threads yet"
        body={
          <>
            A thread opens when Autonomous is on and a workspace is set to "Runs it". Choose one on the{" "}
            <PageLink page="captain" className="text-blue hover:underline">
              Captain page
            </PageLink>
            .
          </>
        }
      />
    );
  if (results.some((r) => r.isPending)) return <RowsSkeleton rows={4} height={56} />;
  if (lines.length === 0)
    return <PanelNote title="Nothing yet" body="What the captain reports and what you tell it shows here." />;
  return (
    <ul
      aria-label="All threads, newest first"
      className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain pr-1 scroll-fade"
    >
      {lines.map((line) => (
        <li key={line.key}>
          <button
            type="button"
            onClick={() => onPick(line.org)}
            className="flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-lg border border-line bg-raised/60 px-3 py-2 text-left hover:border-line-hover"
          >
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="max-w-[55%] shrink-0 truncate rounded-full border border-line-control px-2 py-px text-fg-soft">
                {names.get(line.org) ?? line.org}
              </span>
              <span className={line.who === "You" ? "text-fg-soft" : "text-fg-muted"}>{line.who}</span>
              <time dateTime={line.at} className="tnum ml-auto shrink-0 text-fg-faint">
                {formatAgo(line.at, now)}
              </time>
            </span>
            <span className="line-clamp-3 break-words text-base text-fg-soft">{line.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One workspace's thread: its state, today's spend, Start fresh, the conversation and the box. */
function ThreadTab({ org, autonomy }: { org: CaptainOrg; autonomy: CaptainStatusMode }) {
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
      {autonomy === "off" && (
        <p className="shrink-0 text-xs text-fg-faint text-pretty">
          Autonomous is off. The captain answers here, and does nothing by itself.
        </p>
      )}
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

type CaptainStatusMode = "off" | "on" | "paused" | "stopping";

function PanelNote({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="m-auto flex max-w-[300px] flex-col items-center gap-1.5 text-center">
      <p className="text-base font-medium text-fg">{title}</p>
      <p className="text-sm text-fg-muted text-pretty">{body}</p>
    </div>
  );
}
