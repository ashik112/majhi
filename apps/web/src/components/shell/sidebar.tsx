import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronsUpDown, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppearanceButton } from "@/components/shell/appearance";
import { Bell } from "@/components/shell/bell";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";
import { useAnchoredPanel } from "@/components/ui/anchored";
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
import { PAGE_LABEL, SETUP_PAGES } from "@/features/shell/nav";
import { chordOf } from "@/features/shell/shortcuts";
import { UpdateNotice } from "@/features/update/update-notice";
import { useAgentIndex } from "@/lib/agent-index";
import { prefetchCaptain } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { GLASS, GLASS_STRONG } from "@/lib/glass";
import { useFacts } from "@/lib/memory-queries";
import { useHealthChecks } from "@/lib/ops-queries";
import { PAGE_PATH, type PageName } from "@/lib/pages";
import { useHealth, useHostStatus } from "@/lib/queries";
import { useAccounts } from "@/lib/studio-queries";
import { useProjects, useTasks } from "@/lib/task-queries";
import { useAfterFirstPaint } from "@/lib/use-after-paint";
import { useNow } from "@/lib/use-now";
import { useWatch } from "@/lib/watch-queries";

const ITEM =
  "relative flex cursor-pointer items-center rounded-md text-left transition-colors duration-150 hover:bg-raised hover:text-fg";

/**
 * The sidebar, top to bottom: the brand with the bell, the workspace switcher, the daily rows in the
 * order of the loop (see MainNav), one Setup row, and the agents' lamps at the foot.
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

/** How a row's count reads: red is for what waits for the owner (Decisions only); amber is a thing to look at. */
type NavBadge = { text: string; tone?: "needs" | "check"; dot?: boolean; title?: string };

/**
 * The sidebar's rows, in the order of the daily loop. Brief and decide first (Today, Decisions), then
 * Watch when something is watched; the work the captain is given (Board, Chats, Business); the captain
 * and what it runs on its own (Autonomous, Playbooks); and one Setup row that opens the rest.
 */
function MainNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const waiting = useNeedsYou() ?? 0;
  const isActive = (to: string) =>
    to === "/" ? pathname === "/" || pathname.startsWith("/t/") : pathname.startsWith(to);
  const gap = "gap-4 [@media(max-height:799px)]:gap-2.5";
  return (
    <nav aria-label="Main" className={cn("flex flex-col", gap)}>
      <div className="flex flex-col gap-px">
        <NavRow page="today" active={isActive(PAGE_PATH.today)} />
        <NavRow
          page="decisions"
          active={isActive(PAGE_PATH.decisions)}
          badge={waiting > 0 ? { text: String(waiting), tone: "needs" } : undefined}
        />
        <WatchRow active={isActive(PAGE_PATH.watch)} />
      </div>
      <div className="flex flex-col gap-px">
        <NavRow page="board" active={isActive(PAGE_PATH.board)} />
        <NavRow page="chats" active={isActive(PAGE_PATH.chats)} />
        <NavRow page="business" active={isActive(PAGE_PATH.business)} />
      </div>
      <div className="flex flex-col gap-px">
        <CaptainRow />
        <AutonomyRow />
        <NavRow page="playbooks" active={isActive(PAGE_PATH.playbooks)} sub />
      </div>
      <SetupGroup isActive={isActive} />
    </nav>
  );
}

/**
 * Setup: one row that opens a menu of the pages set up once (Agents, Accounts, Connections, and the
 * rest), so the sidebar keeps its size on any window. When one of them is on screen the row is selected
 * and names it. A dot says that something inside needs a look, and the menu says what. None of it is a
 * decision, so none of it is red.
 */
function SetupGroup({ isActive }: { isActive: (to: string) => boolean }) {
  const agents = useAgentIndex();
  const accounts = useAccounts().data;
  const settled = useAfterFirstPaint(2_000);
  const checks = useHealthChecks(settled).data?.checks;
  const pendingFacts = useFacts({ status: "pending" }, settled).data ?? [];
  const projects = useProjects().data;
  const signIn = accountsNeedingYou(accounts ?? []).length;
  const toFix = checksNeedingYou(checks);
  const toReview = pendingFacts.length;
  const reviewAt = reviewTarget(pendingFacts, new Map((projects ?? []).map((p) => [p.id, p.org])));
  const current = SETUP_PAGES.find((page) => isActive(PAGE_PATH[page]));
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const { panel, style, container } = useAnchoredPanel({
    open,
    close,
    trigger,
    matchWidth: true,
    maxHeight: 520,
  });

  useEffect(() => {
    if (!open) return;
    const items = panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const here = panel.current?.querySelector<HTMLElement>('[aria-current="page"]');
    (here ?? items?.[0])?.focus();
  }, [open, panel]);

  // Esc closes the menu wherever the focus is.
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    nodes[(next + nodes.length) % nodes.length]?.focus();
  }

  const notes = [
    toFix > 0 ? `${toFix} to fix` : undefined,
    signIn > 0 ? `${signIn} to sign in` : undefined,
    toReview > 0 ? `${toReview} to review` : undefined,
  ].filter((note): note is string => note !== undefined);
  const badge: Partial<Record<PageName, NavBadge>> = {};
  if (agents.size > 0) badge.agents = { text: String(agents.size) };
  if ((accounts?.length ?? 0) > 0 || signIn > 0)
    badge.accounts = { text: String(accounts?.length ?? 0), dot: signIn > 0 };
  if (toFix > 0) badge.usage = { text: `${toFix} to fix`, tone: "check" };
  if (toReview > 0) badge.memory = { text: `${toReview} to review`, tone: "check" };

  return (
    <div className="flex flex-col gap-px">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={notes.length > 0 ? `Setup: ${notes.join(", ")}` : "Setup"}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          ITEM,
          "h-8 shrink-0 gap-2 px-2.5 text-body font-medium",
          current !== undefined || open ? ROW_SELECTED : "text-fg-muted",
        )}
      >
        <span className="shrink-0">Setup</span>
        <span className="ml-auto flex min-w-0 items-center gap-2">
          {current !== undefined && (
            <span className="min-w-0 truncate text-sm font-normal text-fg-muted">{PAGE_LABEL[current]}</span>
          )}
          {notes.length > 0 && (
            <span className="flex shrink-0 items-center gap-1.5 text-xs font-normal text-caution">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              <span className="sr-only">{notes.join(", ")}</span>
              {current === undefined && (notes.length > 1 ? notes.length : notes[0])}
            </span>
          )}
          <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-faint" />
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            popover="manual"
            id={id}
            role="menu"
            aria-label="Setup"
            style={style}
            onKeyDown={onKeyDown}
            className={cn(
              "z-50 flex min-w-[220px] max-w-[300px] flex-col overflow-y-auto rounded-lg p-1",
              GLASS_STRONG,
            )}
          >
            {SETUP_PAGES.map((page) => {
              const b = badge[page];
              const chord = chordOf(PAGE_PATH[page]);
              const link = page === "memory" && b !== undefined && reviewAt !== undefined;
              return (
                <Link
                  key={page}
                  to={PAGE_PATH[page]}
                  search={link ? { project: reviewAt, tab: "lessons" } : {}}
                  role="menuitem"
                  aria-current={isActive(PAGE_PATH[page]) ? "page" : undefined}
                  onClick={close}
                  className={cn(
                    "flex h-8 min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-base hover:bg-raised focus-visible:bg-raised focus-visible:outline-none",
                    isActive(PAGE_PATH[page]) ? "font-medium text-fg" : "text-fg-soft",
                  )}
                >
                  <span className="min-w-0 truncate">{PAGE_LABEL[page]}</span>
                  {b !== undefined && (
                    <span
                      className={cn(
                        "tnum ml-auto flex shrink-0 items-center gap-1.5 text-xs",
                        b.tone === "check" ? "text-caution" : "text-fg-faint",
                      )}
                    >
                      {b.dot && (
                        <>
                          <Lamp state="needs" size={6} />
                          <span className="sr-only">An account needs you. </span>
                        </>
                      )}
                      {b.text}
                    </span>
                  )}
                  {b === undefined && chord !== undefined && <Kbd className="ml-auto">{chord}</Kbd>}
                </Link>
              );
            })}
          </div>,
          container,
        )}
    </div>
  );
}

function NavRow({
  page,
  active,
  badge,
  className,
  sub,
}: {
  page: PageName;
  active: boolean;
  badge?: NavBadge | undefined;
  className?: string;
  /** A row under Captain: indented behind a rule. */
  sub?: boolean;
}) {
  const chord = chordOf(PAGE_PATH[page]);
  return (
    <Link
      to={PAGE_PATH[page]}
      search={{}}
      aria-current={active ? "page" : undefined}
      title={chord === undefined ? PAGE_LABEL[page] : `${PAGE_LABEL[page]} (${chord})`}
      className={cn(
        ITEM,
        "h-8 shrink-0 px-2.5 text-body font-medium",
        sub && "ml-2.5 border-l border-line pl-2",
        active ? ROW_SELECTED : "text-fg-muted",
        className,
      )}
    >
      <span className={cn("min-w-0 truncate", sub && "pl-1.5")}>{PAGE_LABEL[page]}</span>
      {badge && (
        <span
          title={badge.title}
          className={cn(
            "tnum ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs font-normal",
            badge.tone === "needs" && "text-lamp-needs",
            badge.tone === "check" && "text-caution",
            badge.tone === undefined && "text-fg-faint",
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
 * Watch: what is watched and the incidents. It shows only when something is watched or an incident is
 * open, and carries a lamp only while a service is down or an incident is open, so a quiet day is a quiet row.
 */
function WatchRow({ active }: { active: boolean }) {
  const watch = useWatch().data;
  const down = watch?.services.filter((s) => s.status === "down").length ?? 0;
  const open = watch?.incidents.filter((i) => i.status === "open").length ?? 0;
  const lit = Math.max(down, open);
  const hasAny = (watch?.services.length ?? 0) > 0 || open > 0;
  if (!hasAny && !active) return null;
  return (
    <NavRow
      page="watch"
      active={active}
      badge={
        lit > 0 ? { text: down > 0 ? `${down} down` : `${open} open`, tone: "needs", dot: false } : undefined
      }
    />
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
      className="ml-2.5 flex shrink-0 items-center gap-1 border-l border-line pl-2"
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

/** Four lamps with counts, every agent counted once, and the Appearance button. */
function AgentsNow() {
  const index = useAgentIndex();
  const tasks = useTasks().data;
  const accounts = useAccounts().data;
  const checksAt = useHealthChecks(useAfterFirstPaint(2_000)).data?.checkedAt;
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
      <Link
        to={PAGE_PATH.usage}
        search={{}}
        title="Open Health and usage"
        className="truncate rounded-sm px-1 text-xs text-fg-faint transition-colors duration-150 hover:text-fg [@media(max-height:799px)]:hidden"
      >
        {healthCheckedText(accounts ?? [], now, checksAt)}
      </Link>
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
