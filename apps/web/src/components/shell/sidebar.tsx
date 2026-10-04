import type { AccountView, TaskSummary } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Anchor,
  BookOpen,
  CircleAlert,
  House,
  KeyRound,
  Library,
  type LucideIcon,
  MessagesSquare,
  Radar,
  Settings,
  Users,
} from "lucide-react";
import { useMemo } from "react";
import { AppearanceButton } from "@/components/shell/appearance";
import { Bell } from "@/components/shell/bell";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { MajhiMark } from "@/components/ui/majhi-mark";
import { SectionLabel } from "@/components/ui/section-label";
import { useUnseenSummary } from "@/features/autonomy/summary-seen";
import { cardLine, plainTitle } from "@/features/board/model";
import { useBoss } from "@/features/boss/boss-context";
import { useNeedsYou } from "@/features/decisions/needs-you";
import { checksNeedingYou } from "@/features/health/model";
import { isSettingsPath } from "@/features/settings/settings-frame";
import { limitNote } from "@/features/shell/limit-note";
import { accountsNeedingYou, isOpen } from "@/features/shell/model";
import { PAGE_LABEL } from "@/features/shell/nav";
import { chordOf } from "@/features/shell/shortcuts";
import { UpdateNotice } from "@/features/update/update-notice";
import { type AgentInfo, useAgentIndex } from "@/lib/agent-index";
import { prefetchCaptain } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useFacts } from "@/lib/memory-queries";
import { useHealthChecks } from "@/lib/ops-queries";
import { PAGE_PATH, type PageName } from "@/lib/pages";
import { useHealth, useHostStatus } from "@/lib/queries";
import { useAccounts } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useAfterFirstPaint } from "@/lib/use-after-paint";
import { useNow } from "@/lib/use-now";
import { useWatch } from "@/lib/watch-queries";

const ITEM =
  "relative flex cursor-pointer items-center rounded-md text-left transition-colors duration-150 hover:bg-raised hover:text-fg";

/**
 * The sidebar, top to bottom: the brand with the bell, the workspace switcher, the daily work, the team
 * (see MainNav), the agents that work now, and the foot rows.
 */
export function Sidebar() {
  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        "relative z-20 flex h-full w-[228px] shrink-0 flex-col gap-3 rounded-2xl px-3 pt-4 pb-3 [@media(max-height:799px)]:gap-2.5 [@media(max-height:799px)]:pt-3",
        GLASS,
      )}
    >
      <Brand />
      <WorkspaceSwitcher />
      {/* The middle scrolls only when a short window needs the room. The update row sits below it, never over it. */}
      <div className="-mx-3 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-3 pt-0.5 pb-2 scroll-fade">
        <MainNav />
        <AgentsNow />
      </div>
      <UpdateNotice />
      <FootNav />
    </aside>
  );
}

function Brand() {
  const health = useHealth();
  const host = useHostStatus();
  const state = health.isPending ? "checking" : health.online ? "online" : "offline";
  const helperOff = state === "online" && host.data?.connected === false;
  const title =
    state === "online"
      ? `majhi ${health.data?.version ?? ""} is running.${helperOff ? " The host helper is not connected; make up installs it." : ""}`
      : state === "offline"
        ? "majhi is not answering. Start it with make up."
        : "Checking the server";
  return (
    <div className="flex items-center gap-2 pl-1.5">
      <Link
        to="/"
        search={{}}
        aria-label="majhi, go to the board"
        className="flex items-center gap-2.5 rounded-md"
      >
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-[7px] bg-brand text-brand-ink shadow-[0_4px_14px_-4px_var(--c-brand)]"
        >
          <MajhiMark className="w-[19px]" />
        </span>
        <span className="text-[16px] font-semibold tracking-[-0.01em]">majhi</span>
      </Link>
      <span
        role="status"
        title={title}
        className="ml-auto flex flex-col items-end font-mono text-xs leading-[13px]"
      >
        <span
          className={cn(
            "flex items-center gap-1.5",
            state === "online" && "text-green",
            state === "offline" && "text-red",
            state === "checking" && "animate-shimmer text-fg-faint",
          )}
        >
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-current shadow-[0_0_6px_currentColor]"
          />
          {state === "checking" ? "connecting" : state}
        </span>
        {helperOff && <span className="text-amber">helper off</span>}
      </span>
      <Bell />
    </div>
  );
}

/** How a row's count reads: red is for what waits for the owner; amber is a thing to look at. */
type NavBadge = { text: string; tone?: "needs" | "check"; dot?: boolean; title?: string };

const ICON = "size-4 shrink-0";

/**
 * The sidebar's rows: Home, Needs you, Chats, the captain, Playbooks, Watch and Knowledge; then the
 * agents that work now (see AgentsNow); at the foot Agents, Accounts, Health & usage and Settings.
 */
function MainNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const waiting = useNeedsYou() ?? 0;
  const isActive = (to: string) =>
    to === "/" ? pathname === "/" || pathname.startsWith("/t/") : pathname.startsWith(to);
  return (
    <nav aria-label="Main" className="flex flex-col gap-px">
      <NavRow page="board" label="Home" icon={House} active={isActive(PAGE_PATH.board)} />
      <NavRow
        page="decisions"
        label="Needs you"
        icon={CircleAlert}
        active={isActive(PAGE_PATH.decisions)}
        badge={waiting > 0 ? { text: String(waiting), tone: "needs" } : undefined}
      />
      <NavRow page="chats" icon={MessagesSquare} active={isActive(PAGE_PATH.chats)} />
      <CaptainRow />
      <NavRow page="playbooks" icon={BookOpen} active={isActive(PAGE_PATH.playbooks)} />
      <WatchRow active={isActive(PAGE_PATH.watch)} />
      <NavRow page="business" icon={Library} active={isActive(PAGE_PATH.business)} />
    </nav>
  );
}

/** The foot: who works (Agents), what they sign in with (Accounts), how it runs (Health & usage), Settings. */
function FootNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isActive = (to: string) => pathname.startsWith(to);
  const agents = useAgentIndex();
  const accounts = useAccounts().data;
  const settled = useAfterFirstPaint(6_000);
  const checks = useHealthChecks(settled).data?.checks;
  const toReview = (useFacts({ status: "pending" }, settled).data ?? []).length;
  const signIn = accountsNeedingYou(accounts ?? []).length;
  const toFix = checksNeedingYou(checks);
  const settings = isSettingsPath(pathname) || isActive(PAGE_PATH.setup);
  return (
    <div className="flex shrink-0 flex-col gap-px border-t border-line pt-2">
      <NavRow
        page="agents"
        icon={Users}
        active={isActive(PAGE_PATH.agents)}
        badge={agents.size > 0 ? { text: String(agents.size) } : undefined}
      />
      <NavRow
        page="accounts"
        icon={KeyRound}
        active={isActive(PAGE_PATH.accounts)}
        badge={
          signIn > 0
            ? { text: `${signIn} sign in`, tone: "needs" }
            : (accounts?.length ?? 0) > 0
              ? { text: String(accounts?.length ?? 0) }
              : undefined
        }
      />
      <NavRow
        page="usage"
        icon={Activity}
        active={isActive(PAGE_PATH.usage)}
        badge={toFix > 0 ? { text: `${toFix} to fix`, tone: "check" } : undefined}
      />
      <div className="flex items-center gap-1">
        <Link
          to={PAGE_PATH.setup}
          search={{}}
          aria-current={settings ? "page" : undefined}
          title={toReview > 0 ? `Settings: ${toReview} lessons to review in Memory` : "Settings"}
          className={cn(
            ITEM,
            "h-8 min-w-0 flex-1 gap-2 px-2.5 text-body font-medium",
            settings ? ROW_SELECTED : "text-fg-muted",
          )}
        >
          <Settings aria-hidden="true" className={ICON} />
          <span className="shrink-0">Settings</span>
          {toReview > 0 && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-normal text-caution">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              {toReview} to review
            </span>
          )}
        </Link>
        <AppearanceButton />
      </div>
    </div>
  );
}

function NavRow({
  page,
  label,
  icon: Icon,
  active,
  badge,
}: {
  page: PageName;
  label?: string;
  icon: LucideIcon;
  active: boolean;
  badge?: NavBadge | undefined;
}) {
  const chord = chordOf(PAGE_PATH[page]);
  const name = label ?? PAGE_LABEL[page];
  return (
    <Link
      to={PAGE_PATH[page]}
      search={{}}
      aria-current={active ? "page" : undefined}
      title={chord === undefined ? name : `${name} (${chord})`}
      className={cn(
        ITEM,
        "h-8 shrink-0 gap-2 px-2.5 text-body font-medium",
        active ? ROW_SELECTED : "text-fg-muted",
      )}
    >
      <Icon aria-hidden="true" className={ICON} />
      <span className="min-w-0 truncate">{name}</span>
      {badge && (
        <span
          title={badge.title}
          className={cn(
            "tnum ml-auto flex shrink-0 items-center gap-1.5 pl-2 font-mono text-xs font-normal",
            badge.tone === "needs" && "text-lamp-needs",
            badge.tone === "check" && "text-caution",
            badge.tone === undefined && "text-fg-faint",
          )}
        >
          {badge.text}
        </span>
      )}
    </Link>
  );
}

/**
 * Watch: what is watched and the incidents. It carries a count only while a service is down or an
 * incident is open, so a quiet day is a quiet row.
 */
function WatchRow({ active }: { active: boolean }) {
  const watch = useWatch().data;
  const down = watch?.services.filter((s) => s.status === "down").length ?? 0;
  const open = watch?.incidents.filter((i) => i.status === "open").length ?? 0;
  const lit = Math.max(down, open);
  return (
    <NavRow
      page="watch"
      icon={Radar}
      active={active}
      badge={lit > 0 ? { text: down > 0 ? `${down} down` : `${open} open`, tone: "needs" } : undefined}
    />
  );
}

/**
 * The captain: the row opens the Captain page. The chip beside the name opens the captain chat
 * drawer, like Cmd+J.
 */
function CaptainRow() {
  const { open, toggle } = useBoss();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = pathname.startsWith(PAGE_PATH.captain);
  const now = useNow(60_000);
  const summary = useUnseenSummary(now);
  const client = useQueryClient();
  const warm = () => prefetchCaptain(client);
  return (
    <div className="flex h-8 shrink-0 items-center gap-1">
      <Link
        to={PAGE_PATH.captain}
        search={{}}
        onPointerEnter={warm}
        onFocus={warm}
        aria-description={summary === undefined ? undefined : "A new daily summary is ready"}
        aria-current={active ? "page" : undefined}
        className={cn(
          ITEM,
          "h-8 min-w-0 flex-1 gap-2 px-2.5 text-body font-medium",
          active ? ROW_SELECTED : "text-fg-muted",
        )}
      >
        <Anchor aria-hidden="true" className={ICON} />
        <span className="truncate">Captain</span>
        {summary !== undefined && (
          <span
            aria-hidden="true"
            title="A new daily summary is ready"
            className="size-1.5 shrink-0 rounded-full bg-lamp-needs shadow-[0_0_6px_currentColor]"
          />
        )}
      </Link>
      <button
        type="button"
        aria-pressed={open}
        aria-label="Open the captain chat"
        onPointerEnter={warm}
        title={`Open the captain chat (${MOD_KEY} J)`}
        onClick={toggle}
        className={cn(
          ITEM,
          "h-8 shrink-0 justify-center px-1.5 font-mono text-xs",
          open ? ROW_SELECTED : "text-fg-faint",
        )}
      >
        {MOD_KEY} J
      </button>
    </div>
  );
}

interface AgentRow {
  id: string;
  emoji: string | undefined;
  lamp: LampState;
  line: string;
  limit: string | undefined;
}

/** The agents that are busy, paused or near their account's limit, and a count of the idle rest. */
function agentRows(
  agents: readonly AgentInfo[],
  tasks: readonly TaskSummary[],
  accounts: readonly AccountView[],
  now: number,
): { rows: AgentRow[]; working: number; idle: number } {
  const open = tasks.filter(isOpen);
  const rows: AgentRow[] = [];
  let idle = 0;
  for (const agent of agents) {
    const note = limitNote(
      accounts.find((a) => a.id === agent.account),
      now,
    );
    const running = open.find((t) => t.status === "running" && t.working.includes(agent.id));
    const paused = open.find((t) => t.status === "paused" && t.team.includes(agent.id));
    const base = { id: agent.id, emoji: agent.emoji, limit: note?.text };
    if (running) {
      rows.push({ ...base, lamp: "working", line: plainTitle(running.title) });
    } else if (paused) {
      rows.push({ ...base, lamp: "paused", line: cardLine(paused)?.text ?? "Paused" });
    } else if (note) {
      rows.push({ ...base, lamp: note.full ? "paused" : "idle", line: "Idle" });
    } else idle += 1;
  }
  const rank = { working: 0, paused: 1, needs: 2, done: 3, idle: 4 } as const;
  rows.sort((a, b) => rank[a.lamp] - rank[b.lamp]);
  return { rows, working: rows.filter((r) => r.lamp === "working").length, idle };
}

/** Who works right now and what each agent does; an account near its limit says so with its reset time. */
function AgentsNow() {
  const index = useAgentIndex();
  const tasks = useTasks().data;
  const accounts = useAccounts().data;
  const now = useNow(30_000);
  const { rows, working, idle } = useMemo(
    () => agentRows([...index.values()], tasks ?? [], accounts ?? [], now),
    [index, tasks, accounts, now],
  );
  return (
    <section aria-label="Agents now" className="flex shrink-0 flex-col gap-1">
      <div className="flex items-center gap-2 px-2.5">
        <SectionLabel className="min-w-0 flex-1 truncate">Agents now</SectionLabel>
        <span className="font-mono text-xs text-fg-faint">{working} working</span>
      </div>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li
            key={row.id}
            title={`@${row.id}: ${row.line}${row.limit ? `. ${row.limit}` : ""}`}
            className="flex items-start gap-2 rounded-md px-2.5 py-1 hover:bg-raised"
          >
            <Lamp state={row.lamp} size={7} className="mt-[7px]" />
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-1.5 font-mono text-sm font-medium text-fg-soft">
                {row.emoji && (
                  <span aria-hidden="true" className="font-sans text-sm">
                    {row.emoji}
                  </span>
                )}
                <span className="truncate">@{row.id}</span>
              </span>
              <span className="truncate text-xs text-fg-faint">{row.line}</span>
              {row.limit && (
                <span
                  className={cn(
                    "truncate text-xs",
                    row.lamp === "paused" ? "text-lamp-paused" : "text-caution",
                  )}
                >
                  {row.limit}
                </span>
              )}
            </span>
          </li>
        ))}
        {idle > 0 && <li className="px-2.5 py-1 pl-[27px] text-xs text-fg-faint">{idle} idle</li>}
      </ul>
    </section>
  );
}
