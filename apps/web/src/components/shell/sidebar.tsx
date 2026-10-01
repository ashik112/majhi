import { Link, useRouterState } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import { useMemo } from "react";
import { AppearanceButton } from "@/components/shell/appearance";
import { Kbd } from "@/components/ui/kbd";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { SectionLabel } from "@/components/ui/section-label";
import { useBoss } from "@/features/boss/boss-context";
import { checksNeedingYou } from "@/features/health/model";
import { reviewTarget } from "@/features/memory/model";
import { accountsNeedingYou, agentsRightNow, healthCheckedText, orgRows } from "@/features/shell/model";
import { UpdateNotice } from "@/features/update/update-notice";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useFacts } from "@/lib/memory-queries";
import { useHealthChecks } from "@/lib/ops-queries";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { PAGE_PATH, type PageName } from "@/lib/pages";
import { useHealth, useHostStatus } from "@/lib/queries";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { useProjects, useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";

const NAV: readonly { page: PageName; label: string }[] = [
  { page: "board", label: "Board" },
  { page: "chats", label: "Chats" },
  { page: "agents", label: "Agents" },
  { page: "accounts", label: "Accounts" },
  { page: "usage", label: "Health and usage" },
  { page: "skills", label: "Skills" },
  { page: "memory", label: "Memory" },
  { page: "automations", label: "Automations" },
  { page: "setup", label: "Hub setup" },
  { page: "projects", label: "Projects and links" },
  { page: "orgs", label: "Orgs" },
];

const ITEM =
  "relative flex cursor-pointer items-center rounded-md text-left transition-colors duration-150 hover:bg-raised hover:text-fg";

export function Sidebar() {
  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        "relative z-20 flex h-full w-[228px] shrink-0 flex-col gap-4 rounded-2xl px-3 pt-4 pb-3",
        GLASS,
      )}
    >
      <Brand />
      {/* The middle scrolls when an update notice or many orgs need the room; the lamps stay at the foot. */}
      <div className="-mx-3 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-3 pb-6 scroll-fade">
        <UpdateNotice />
        <MainNav />
        <BossButton />
        <OrgList />
      </div>
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
    <div className="flex items-center gap-2.5 px-1.5">
      <Link
        to="/"
        search={{}}
        aria-label="majhi, go to the board"
        className="flex items-center gap-2.5 rounded-md"
      >
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-[7px] bg-brand font-mono text-sm font-semibold text-brand-ink shadow-[0_4px_14px_-4px_var(--c-brand)]"
        >
          mj
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
    </div>
  );
}

function MainNav() {
  const { org } = useOrgFilter();
  const agents = useAgentIndex();
  const accounts = useAccounts().data;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const checks = useHealthChecks().data?.checks;
  const signIn = accountsNeedingYou(accounts ?? []).length;
  const needYou = checksNeedingYou(checks);
  const pendingFacts = useFacts({ status: "pending" }).data ?? [];
  const projects = useProjects().data;
  const toReview = pendingFacts.length;
  const reviewAt = reviewTarget(pendingFacts, new Map((projects ?? []).map((p) => [p.id, p.org])));
  const badge: Partial<Record<PageName, { text: string; alert?: boolean; dot?: boolean }>> = {};
  if (agents.size > 0) badge.agents = { text: String(agents.size) };
  if ((accounts?.length ?? 0) > 0 || signIn > 0)
    badge.accounts = { text: String(accounts?.length ?? 0), dot: signIn > 0 };
  if (needYou > 0) badge.usage = { text: `${needYou} need you`, alert: true };

  return (
    <nav aria-label="Main" className="flex flex-col gap-px">
      {NAV.map((item) => {
        const to = PAGE_PATH[item.page];
        const shown = badge[item.page];
        const active = to === "/" ? pathname === "/" || pathname.startsWith("/t/") : pathname.startsWith(to);
        if (item.page === "memory" && toReview > 0 && reviewAt !== undefined)
          return (
            <div key={item.page} className="relative flex">
              <Link
                to={to}
                search={orgSearch(org)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  ITEM,
                  "h-8 flex-1 px-2.5 text-body font-medium",
                  active ? ROW_SELECTED : "text-fg-muted",
                )}
              >
                <span>{item.label}</span>
              </Link>
              {/* Its own link: the lessons that wait, on the Lessons tab of their project. */}
              <Link
                to={to}
                search={{ project: reviewAt, tab: "lessons" }}
                title="Open the lessons that wait for you"
                className="tnum absolute top-1 right-1 flex h-6 items-center rounded-[5px] px-1.5 text-xs text-lamp-needs transition-colors duration-150 hover:bg-raised hover:underline"
              >
                {toReview} to review
              </Link>
            </div>
          );
        return (
          <Link
            key={item.page}
            to={to}
            search={orgSearch(org)}
            aria-current={active ? "page" : undefined}
            className={cn(ITEM, "h-8 px-2.5 text-body font-medium", active ? ROW_SELECTED : "text-fg-muted")}
          >
            <span>{item.label}</span>
            {shown && (
              <span
                className={cn(
                  "tnum ml-auto flex items-center gap-1.5 text-xs font-normal",
                  shown.alert ? "text-lamp-needs" : "text-fg-faint",
                )}
              >
                {shown.dot && (
                  <>
                    <Lamp state="needs" size={6} />
                    <span className="sr-only">An account needs you. </span>
                  </>
                )}
                {shown.text}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** Opens the boss chat drawer, like Cmd+J. */
function BossButton() {
  const { open, toggle } = useBoss();
  return (
    <button
      type="button"
      aria-pressed={open}
      onClick={toggle}
      className={cn(
        ITEM,
        "h-8 shrink-0 gap-2 border border-line-strong bg-field px-2.5 text-body font-medium",
        open ? "border-accent-line bg-accent-wash text-fg" : "text-fg-soft",
      )}
    >
      <span>Boss</span>
      <Kbd className="ml-auto">{MOD_KEY} J</Kbd>
    </button>
  );
}

function OrgList() {
  const orgs = useOrgs().data;
  const tasks = useTasks().data;
  const { org, setOrg } = useOrgFilter();
  const rows = useMemo(() => orgRows(orgs ?? [], tasks ?? []), [orgs, tasks]);
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <SectionLabel className="mb-1 ml-2.5">Orgs</SectionLabel>
      <fieldset aria-label="Filter by org" className="m-0 flex min-w-0 flex-col gap-px border-0 p-0">
        {rows.map((row) => {
          const active = row.id === org;
          return (
            <button
              key={row.id ?? "all"}
              type="button"
              aria-pressed={active}
              onClick={() => setOrg(row.id)}
              className={cn(
                ITEM,
                "h-8 shrink-0 gap-2.5 px-2.5 text-base",
                active ? cn(ROW_SELECTED, "font-medium") : "text-fg-soft",
              )}
            >
              {row.id === undefined ? (
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-line-control bg-raised text-fg-soft"
                >
                  <Layers className="size-3" strokeWidth={2.25} />
                </span>
              ) : (
                <OrgBadge label={row.badge} color={row.color} size="sm" />
              )}
              <span className="min-w-0 truncate">{row.name}</span>
              <span className="tnum ml-auto font-mono text-sm text-fg-faint">{row.open}</span>
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}

/** Four lamps with counts: every agent counted once. The Appearance button sits on its last line. */
function AgentsNow() {
  const index = useAgentIndex();
  const tasks = useTasks().data;
  const accounts = useAccounts().data;
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
    <section
      aria-label="Agents right now"
      className="mt-auto flex shrink-0 flex-col gap-2 border-t border-line pt-3"
    >
      <SectionLabel className="px-1">Agents right now</SectionLabel>
      <ul className="grid grid-cols-2 gap-1">
        {rows.map((row) => (
          <li
            key={row.label}
            title={`${row.title}: ${row.count}`}
            className="flex h-7 min-w-0 items-center gap-2 rounded-md border border-line bg-field px-2 text-xs"
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
      <div className="flex items-center gap-2 pl-1">
        <span className="min-w-0 flex-1 truncate text-xs text-fg-faint">
          {healthCheckedText(accounts ?? [], now)}
        </span>
        <AppearanceButton />
      </div>
    </section>
  );
}
