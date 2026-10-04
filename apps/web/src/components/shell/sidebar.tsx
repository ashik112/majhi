import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { AppearanceButton } from "@/components/shell/appearance";
import { Bell } from "@/components/shell/bell";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";
import { Kbd } from "@/components/ui/kbd";
import { LAMP_TEXT, Lamp, type LampState } from "@/components/ui/lamp";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { MajhiMark } from "@/components/ui/majhi-mark";
import { SectionLabel } from "@/components/ui/section-label";
import { MODE_LAMP, MODE_WORD } from "@/features/autonomy/model";
import { useUnseenSummary } from "@/features/autonomy/summary-seen";
import { SpendToday, useAutonomousSwitch } from "@/features/autonomy/switch";
import { useBoss } from "@/features/boss/boss-context";
import { useNeedsYou } from "@/features/decisions/needs-you";
import { checksNeedingYou } from "@/features/health/model";
import { reviewTarget } from "@/features/memory/model";
import { accountsNeedingYou, agentsRightNow, healthCheckedText } from "@/features/shell/model";
import { NAV_GROUPS, PAGE_LABEL } from "@/features/shell/nav";
import { UpdateNotice } from "@/features/update/update-notice";
import { useAgentIndex } from "@/lib/agent-index";
import { prefetchCaptain } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useFacts } from "@/lib/memory-queries";
import { useHealthChecks } from "@/lib/ops-queries";
import { PAGE_PATH, type PageName } from "@/lib/pages";
import { useHealth, useHostStatus } from "@/lib/queries";
import { useAccounts } from "@/lib/studio-queries";
import { useProjects, useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { useWatch } from "@/lib/watch-queries";

const ITEM =
  "relative flex cursor-pointer items-center rounded-md text-left transition-colors duration-150 hover:bg-raised hover:text-fg";

/**
 * The sidebar, top to bottom: the brand with the bell, the workspace switcher, the daily rows (Board,
 * Chats, Captain, Autonomous), the pages set up once (Setup), the ones opened rarely (System), and the
 * agents' lamps at the foot.
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
      </div>
      <UpdateNotice />
      <AgentsNow />
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

type NavBadge = { text: string; alert?: boolean; dot?: boolean };

function MainNav() {
  const agents = useAgentIndex();
  const accounts = useAccounts().data;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const checks = useHealthChecks().data?.checks;
  const signIn = accountsNeedingYou(accounts ?? []).length;
  const needYou = checksNeedingYou(checks);
  const waiting = useNeedsYou() ?? 0;
  const pendingFacts = useFacts({ status: "pending" }).data ?? [];
  const projects = useProjects().data;
  const toReview = pendingFacts.length;
  const reviewAt = reviewTarget(pendingFacts, new Map((projects ?? []).map((p) => [p.id, p.org])));
  const badge: Partial<Record<PageName, NavBadge>> = {};
  if (agents.size > 0) badge.agents = { text: String(agents.size) };
  if ((accounts?.length ?? 0) > 0 || signIn > 0)
    badge.accounts = { text: String(accounts?.length ?? 0), dot: signIn > 0 };
  if (needYou > 0) badge.usage = { text: `${needYou} to fix`, alert: true };
  const isActive = (to: string) =>
    to === "/" ? pathname === "/" || pathname.startsWith("/t/") : pathname.startsWith(to);

  return (
    <nav aria-label="Main" className="flex flex-col gap-4 [@media(max-height:799px)]:gap-2.5">
      <div className="flex flex-col gap-px">
        <NavRow page="today" active={isActive(PAGE_PATH.today)} />
        <NavRow page="board" active={isActive(PAGE_PATH.board)} />
        <NavRow page="chats" active={isActive(PAGE_PATH.chats)} />
        <NavRow
          page="decisions"
          active={isActive(PAGE_PATH.decisions)}
          badge={waiting > 0 ? { text: String(waiting), alert: true } : undefined}
        />
        <CaptainRow />
        <AutonomyRow />
        <PlaybooksRow active={isActive(PAGE_PATH.playbooks)} />
        <WatchRow active={isActive(PAGE_PATH.watch)} />
        <NavRow page="business" active={isActive(PAGE_PATH.business)} />
      </div>
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-px">
          <SectionLabel className="mb-1 px-2.5">{group.label}</SectionLabel>
          {group.pages.map((page) =>
            page === "memory" && toReview > 0 && reviewAt !== undefined ? (
              <div key={page} className="relative flex">
                <NavRow page={page} active={isActive(PAGE_PATH[page])} className="flex-1" />
                {/* Its own link: the lessons that wait, on the Lessons tab of their project. */}
                <Link
                  to={PAGE_PATH.memory}
                  search={{ project: reviewAt, tab: "lessons" }}
                  title="Open the lessons that wait for you"
                  className="tnum absolute top-1 right-1 flex h-6 items-center rounded-[5px] px-1.5 text-xs text-lamp-needs transition-colors duration-150 hover:bg-raised hover:underline"
                >
                  {toReview} to review
                </Link>
              </div>
            ) : (
              <NavRow key={page} page={page} active={isActive(PAGE_PATH[page])} badge={badge[page]} />
            ),
          )}
        </div>
      ))}
    </nav>
  );
}

function NavRow({
  page,
  active,
  badge,
  className,
}: {
  page: PageName;
  active: boolean;
  badge?: NavBadge | undefined;
  className?: string;
}) {
  return (
    <Link
      to={PAGE_PATH[page]}
      search={{}}
      aria-current={active ? "page" : undefined}
      className={cn(
        ITEM,
        "h-8 shrink-0 px-2.5 text-body font-medium",
        active ? ROW_SELECTED : "text-fg-muted",
        className,
      )}
    >
      <span className="min-w-0 truncate">{PAGE_LABEL[page]}</span>
      {badge && (
        <span
          className={cn(
            "tnum ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs font-normal",
            badge.alert ? "text-lamp-needs" : "text-fg-faint",
          )}
        >
          {badge.dot && (
            <>
              <Lamp state="needs" size={6} />
              <span className="sr-only">An account needs you. </span>
            </>
          )}
          {badge.text}
        </span>
      )}
    </Link>
  );
}

/**
 * The captain: the row opens the Captain page (today, chat, log and rules). The chat button beside it opens the captain chat drawer,
 * like Cmd+J.
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
          "h-8 shrink-0 justify-center gap-1 px-1.5",
          open ? ROW_SELECTED : "text-fg-faint",
        )}
      >
        <MessageSquare aria-hidden="true" className="size-3.5" />
        <Kbd>{MOD_KEY} J</Kbd>
      </button>
    </div>
  );
}

/**
 * Autonomous, a sub-row of Captain: its lamp, state and the switch, with today's spend under the
 * name. It is not a page: the switch turns it on (after a short dialog) or off (pause its tasks, or
 * let them finish their step).
 */
function AutonomyRow() {
  const { status, unavailable, mode, toggle, dialogs } = useAutonomousSwitch();
  const lamp = MODE_LAMP[mode];
  // What holds Autonomous (a budget, an account under its floor) was a banner on every page; it is the tooltip now.
  const hold = status?.holds[0]?.text;
  return (
    <div
      title={hold ?? unavailable}
      className="mb-1 ml-2.5 flex shrink-0 items-center gap-1 border-l border-line pl-2"
    >
      <div className="flex min-h-8 min-w-0 flex-1 flex-col justify-center px-1.5 py-1 text-body font-medium text-fg-muted">
        <span className="flex min-w-0 items-center gap-2">
          <Lamp state={lamp} size={7} />
          <span className="truncate">Autonomous</span>
          <span className={cn("ml-auto shrink-0 text-xs font-normal", LAMP_TEXT[lamp])}>
            {MODE_WORD[mode]}
          </span>
        </span>
        {status && <SpendToday status={status} className="pl-[15px] text-xs font-normal" />}
      </div>
      {toggle}
      {dialogs}
    </div>
  );
}

/** Playbooks, a sub-row of Captain beside Autonomous: the captain's standing work, one page. */
function PlaybooksRow({ active }: { active: boolean }) {
  return (
    <Link
      to={PAGE_PATH.playbooks}
      search={{}}
      aria-current={active ? "page" : undefined}
      className={cn(
        ITEM,
        "mb-1 ml-2.5 h-8 shrink-0 border-l border-line pl-2 text-body font-medium",
        active ? ROW_SELECTED : "text-fg-muted",
      )}
    >
      <span className="truncate pl-1.5">Playbooks</span>
    </Link>
  );
}

/**
 * Watch, a sub-row of Captain beside Playbooks: what is watched and the incidents. It shows a lamp only
 * while a service is down or an incident is open, so a quiet day is a quiet row.
 */
function WatchRow({ active }: { active: boolean }) {
  const watch = useWatch().data;
  const down = watch?.services.filter((s) => s.status === "down").length ?? 0;
  const open = watch?.incidents.filter((i) => i.status === "open").length ?? 0;
  const lit = Math.max(down, open);
  const hasAny = (watch?.services.length ?? 0) > 0 || open > 0;
  if (!hasAny && !active) return null;
  return (
    <Link
      to={PAGE_PATH.watch}
      search={{}}
      aria-current={active ? "page" : undefined}
      className={cn(
        ITEM,
        "mb-1 ml-2.5 h-8 shrink-0 border-l border-line pl-2 text-body font-medium",
        active ? ROW_SELECTED : "text-fg-muted",
      )}
    >
      <span className="flex min-w-0 items-center gap-2 pl-1.5">
        <span className="truncate">Watch</span>
        {lit > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-normal text-lamp-needs">
            <Lamp state="needs" size={7} />
            {down > 0 ? `${down} down` : `${open} open`}
          </span>
        )}
      </span>
    </Link>
  );
}

/** Four lamps with counts, every agent counted once, and the Appearance button. */
function AgentsNow() {
  const index = useAgentIndex();
  const tasks = useTasks().data;
  const accounts = useAccounts().data;
  const checksAt = useHealthChecks().data?.checkedAt;
  const now = useNow(30_000);
  const pulse = useMemo(
    () => agentsRightNow([...index.values()], tasks ?? [], accounts ?? []),
    [index, tasks, accounts],
  );
  const rows: { label: string; title: string; count: number; lamp: LampState }[] = [
    { label: "Working", title: "Working", count: pulse.working, lamp: "working" },
    { label: "Paused", title: "Paused", count: pulse.paused, lamp: "paused" },
    { label: "Limit", title: "Limit reached", count: pulse.limit, lamp: "paused" },
    { label: "Idle", title: "Idle", count: pulse.idle, lamp: "idle" },
  ];
  return (
    <section aria-label="Agents right now" className="flex shrink-0 flex-col gap-1 border-t border-line pt-2">
      {/* Below 800px of window height the lamps fold into one line with their counts, so the
          navigation keeps its room. */}
      <div className="flex items-center gap-2 pl-1 [@media(max-height:799px)]:hidden">
        <SectionLabel className="min-w-0 flex-1 truncate">Agents right now</SectionLabel>
        <AppearanceButton />
      </div>
      <ul className="grid grid-cols-2 gap-x-3 px-1 [@media(max-height:799px)]:hidden">
        {rows.map((row) => (
          <li
            key={row.label}
            title={`${row.title}: ${row.count}`}
            className="flex h-6 min-w-0 items-center gap-2 text-xs"
          >
            <Lamp state={row.lamp} dim={row.count === 0} size={7} />
            <span className={cn("min-w-0 truncate", row.count > 0 ? "text-fg-soft" : "text-fg-faint")}>
              {row.label}
            </span>
            <span
              className={cn("tnum ml-auto font-mono text-sm", row.count > 0 ? "text-fg" : "text-fg-faint")}
            >
              {row.count}
            </span>
          </li>
        ))}
      </ul>
      <p className="truncate px-1 text-xs text-fg-faint [@media(max-height:799px)]:hidden">
        {healthCheckedText(accounts ?? [], now, checksAt)}
      </p>
      <div className="hidden items-center gap-3 pl-1 [@media(max-height:799px)]:flex">
        <ul aria-label="Agents right now" className="flex min-w-0 flex-1 items-center gap-3">
          {rows.map((row) => (
            <li
              key={row.label}
              title={`${row.title}: ${row.count}`}
              className="flex h-7 items-center gap-1.5"
            >
              <Lamp state={row.lamp} dim={row.count === 0} size={7} />
              <span className="sr-only">{row.label}</span>
              <span className={cn("tnum font-mono text-sm", row.count > 0 ? "text-fg" : "text-fg-faint")}>
                {row.count}
              </span>
            </li>
          ))}
        </ul>
        <AppearanceButton />
      </div>
    </section>
  );
}
