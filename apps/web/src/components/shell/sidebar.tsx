import { Link, useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";
import { Kbd } from "@/components/ui/kbd";
import { OrgBadge } from "@/components/ui/org-badge";
import { SectionLabel } from "@/components/ui/section-label";
import { useBoss } from "@/features/boss/boss-context";
import { checksNeedingYou } from "@/features/health/model";
import { accountsNeedingYou, agentsRightNow, healthCheckedText, orgRows } from "@/features/shell/model";
import { UpdateNotice } from "@/features/update/update-notice";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { useHealthChecks } from "@/lib/ops-queries";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { PAGE_PATH, type PageName } from "@/lib/pages";
import { useHealth, useHostStatus } from "@/lib/queries";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";

const NAV: readonly { page: PageName; label: string }[] = [
  { page: "board", label: "Board" },
  { page: "agents", label: "Agents" },
  { page: "usage", label: "Health and usage" },
  { page: "skills", label: "Skills" },
  { page: "setup", label: "Hub setup" },
  { page: "projects", label: "Projects and links" },
  { page: "orgs", label: "Orgs and accounts" },
];

const ITEM =
  "flex cursor-pointer items-center rounded-md text-left transition-colors duration-150 hover:bg-raised hover:text-fg";

export function Sidebar() {
  return (
    <aside
      aria-label="Sidebar"
      className="flex h-full w-60 shrink-0 flex-col gap-5 border-r border-line-strong bg-rail px-3.5 py-5"
    >
      <Brand />
      <UpdateNotice />
      <MainNav />
      <BossButton />
      <OrgList />
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
    <div className="flex items-center gap-2.5 px-2">
      <Link
        to="/"
        search={{}}
        aria-label="majhi, go to the board"
        className="flex items-center gap-2.5 rounded-md"
      >
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-[7px] bg-amber font-mono text-sm font-semibold text-amber-ink"
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
            state === "online" && "text-green",
            state === "offline" && "text-red",
            state === "checking" && "animate-shimmer text-fg-faint",
          )}
        >
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
  const needYou = accountsNeedingYou(accounts ?? []).length + checksNeedingYou(checks);
  const badge: Partial<Record<PageName, { text: string; alert?: boolean }>> = {};
  if (agents.size > 0) badge.agents = { text: String(agents.size) };
  if (needYou > 0) badge.usage = { text: `${needYou} need you`, alert: true };

  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const to = PAGE_PATH[item.page];
        const shown = badge[item.page];
        const active = to === "/" ? pathname === "/" || pathname.startsWith("/t/") : pathname.startsWith(to);
        return (
          <Link
            key={item.page}
            to={to}
            search={orgSearch(org)}
            aria-current={active ? "page" : undefined}
            className={cn(
              ITEM,
              "h-9 px-3 text-body font-medium",
              active ? "bg-selected text-fg" : "text-fg-muted",
            )}
          >
            <span>{item.label}</span>
            {shown && (
              <span
                className={cn(
                  "tnum ml-auto text-xs font-normal",
                  shown.alert ? "text-coral" : "text-fg-faint",
                )}
              >
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
        "h-9 gap-2 border border-line-strong px-3 text-body font-medium",
        open ? "bg-selected text-fg" : "text-fg-soft",
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
    <div className="flex min-h-0 flex-col gap-1">
      <SectionLabel className="mb-1 ml-3">Orgs</SectionLabel>
      <fieldset
        aria-label="Filter by org"
        className="m-0 flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto border-0 p-0"
      >
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
                "h-[34px] shrink-0 gap-2.5 px-3 text-base",
                active ? "bg-selected text-fg" : "text-fg-soft",
              )}
            >
              <OrgBadge label={row.badge} color={row.color} />
              <span className="min-w-0 truncate">{row.name}</span>
              <span className="tnum ml-auto font-mono text-sm text-fg-faint">{row.open}</span>
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}

function AgentsNow() {
  const index = useAgentIndex();
  const tasks = useTasks().data;
  const accounts = useAccounts().data;
  const now = useNow(30_000);
  const pulse = useMemo(
    () => agentsRightNow([...index.values()], tasks ?? [], accounts ?? []),
    [index, tasks, accounts],
  );
  const rows = [
    { label: "Working", count: pulse.working, dot: "bg-amber" },
    { label: "Paused", count: pulse.paused, dot: "bg-coral" },
    { label: "Limit reached", count: pulse.limit, dot: "bg-red" },
    { label: "Idle", count: pulse.idle, dot: "bg-fg-dim" },
  ];
  return (
    <section aria-label="Agents right now" className="mt-auto flex flex-col gap-2 rounded-lg bg-raised p-3">
      <SectionLabel>Agents right now</SectionLabel>
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-2 text-sm leading-[1.25]">
          <span aria-hidden="true" className={cn("size-2 rounded-full", row.dot)} />
          <span className="text-fg-soft">{row.label}</span>
          <span className="tnum ml-auto font-mono">{row.count}</span>
        </div>
      ))}
      <span className="text-xs leading-[1.25] text-fg-faint">{healthCheckedText(accounts ?? [], now)}</span>
    </section>
  );
}
