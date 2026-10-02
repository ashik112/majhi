import type { AccountView, TaskSummary } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { Users, X } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentEmoji } from "@/components/agent-avatar";
import { LAMP_TEXT, Lamp, type LampState } from "@/components/ui/lamp";
import { UsageBar } from "@/components/ui/usage-bar";
import { formatPct, usageTone } from "@/features/accounts/model";
import { accountAtLimit, isOpen } from "@/features/shell/model";
import { type AgentInfo, useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { orgSearch } from "@/lib/org-filter";
import { PAGE_PATH } from "@/lib/pages";
import { useAccounts } from "@/lib/studio-queries";
import { isYourTurn } from "../tasks/model";

export interface RosterRow {
  id: string;
  lamp: LampState;
  state: string;
  /** The account's current short window (5 hours), when the tool reports one. */
  pct: number | undefined;
}

const RANK: Record<LampState, number> = { working: 0, needs: 1, paused: 2, done: 3, idle: 4 };

/**
 * The agents of the org filter with their state and how full their account is. An agent working in
 * a task is working; one whose task waits for the owner needs them; one in a paused task or on a full
 * account is paused; the rest are idle. Busiest first, then the fullest account.
 */
export function rosterRows(
  agents: readonly AgentInfo[],
  tasks: readonly TaskSummary[],
  accounts: readonly AccountView[],
  org: string | undefined,
): RosterRow[] {
  const open = tasks.filter((t) => isOpen(t) && (org === undefined || t.org === org));
  const shown = agents.filter(
    (a) =>
      org === undefined ||
      a.scope === org ||
      a.where.includes(org) ||
      open.some((t) => t.team.includes(a.id)),
  );
  return shown
    .map((agent): RosterRow => {
      const account = accounts.find((a) => a.id === agent.account);
      const pct = account?.usage?.window?.usedPct;
      const mine = open.filter((t) => t.team.includes(agent.id));
      if (mine.some((t) => t.status === "running" && t.working.includes(agent.id)))
        return { id: agent.id, lamp: "working", state: "Working", pct };
      if (mine.some((t) => t.status === "review" || isYourTurn(t)))
        return { id: agent.id, lamp: "needs", state: "Needs you", pct };
      if (mine.some((t) => t.status === "paused"))
        return { id: agent.id, lamp: "paused", state: "Paused", pct };
      if (accountAtLimit(account)) return { id: agent.id, lamp: "paused", state: "Limit reached", pct };
      return { id: agent.id, lamp: "idle", state: "Idle", pct };
    })
    .toSorted(
      (a, b) => RANK[a.lamp] - RANK[b.lamp] || (b.pct ?? -1) - (a.pct ?? -1) || a.id.localeCompare(b.id),
    );
}

function useRoster(tasks: readonly TaskSummary[], org: string | undefined): RosterRow[] {
  const index = useAgentIndex();
  const accounts = useAccounts().data;
  return useMemo(
    () => rosterRows([...index.values()], tasks, accounts ?? [], org),
    [index, tasks, accounts, org],
  );
}

/** A calm bar until the account runs high: amber from 80 %, red when full. */
function limitTone(pct: number | undefined): "calm" | "amber" | "red" {
  if (pct === undefined) return "calm";
  const tone = usageTone(pct);
  return tone === "amber" ? "amber" : tone === "red" ? "red" : "calm";
}

function RosterList({ rows, org }: { rows: readonly RosterRow[]; org: string | undefined }) {
  const index = useAgentIndex();
  // One emoji column for every row once any agent has one, so the names line up.
  const withEmoji = rows.some((row) => index.get(row.id)?.emoji);
  if (rows.length === 0) {
    return (
      <p className="px-1 text-sm text-fg-faint text-pretty">
        No agent works in this workspace yet. Add one in Agents.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            to={PAGE_PATH.agents}
            search={{ ...orgSearch(org), agent: row.id }}
            title={`@${row.id}: ${row.state}${row.pct === undefined ? "" : `, account at ${formatPct(row.pct)} of its 5-hour window`}`}
            className="flex flex-col gap-1.5 rounded-lg border border-line bg-field px-2.5 py-2 transition-colors duration-150 hover:border-line-hover hover:bg-raised"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Lamp state={row.lamp} size={7} />
              {withEmoji && (
                <span className="flex w-4 shrink-0 justify-center">
                  <AgentEmoji id={row.id} className="text-sm" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-soft">@{row.id}</span>
            </span>
            <span className="flex items-center gap-2 pl-[15px]">
              <span className={cn("w-[76px] shrink-0 truncate text-xs", LAMP_TEXT[row.lamp])}>
                {row.state}
              </span>
              <UsageBar pct={row.pct ?? 0} tone={limitTone(row.pct)} height={3} className="flex-1" />
              <span
                className={cn(
                  "tnum w-9 shrink-0 text-right font-mono text-xs",
                  row.pct === undefined ? "text-fg-faint" : "text-fg-muted",
                )}
              >
                {row.pct === undefined ? "none" : formatPct(row.pct)}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The agents on the right of the board. Wide screens show the full list; narrower ones a slim rail with
 * the counts that opens the list over the columns.
 */
export function Roster({ tasks, org }: { tasks: readonly TaskSummary[]; org: string | undefined }) {
  const rows = useRoster(tasks, org);
  const [open, setOpen] = useState(false);
  const working = rows.filter((r) => r.lamp === "working").length;
  const waiting = rows.filter((r) => r.lamp === "needs").length;

  return (
    <>
      <aside
        aria-label="Agents"
        className={cn("hidden w-[248px] shrink-0 flex-col gap-3 rounded-2xl p-3 min-[1320px]:flex", GLASS)}
      >
        <RosterHead count={rows.length} working={working} />
        <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2 pb-6 scroll-fade">
          <RosterList rows={rows} org={org} />
        </div>
      </aside>

      <div className="relative flex shrink-0 min-[1320px]:hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Agents: ${working} working, ${waiting} waiting for you`}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex w-11 cursor-pointer flex-col items-center gap-3 rounded-2xl py-3 text-fg-muted transition-colors duration-150 hover:text-fg",
            GLASS,
            open && "border-accent-line text-fg",
          )}
        >
          <Users aria-hidden="true" className="size-4" />
          <span className="text-sm font-medium [writing-mode:vertical-rl]">Agents</span>
          {/* Words beside every lamp: the rail reads "0 working", "3 need you" top to bottom. */}
          <span className="flex flex-col items-center gap-2 text-xs">
            <Lamp state="working" dim={working === 0} size={7} />
            <span className={cn("[writing-mode:vertical-rl]", working === 0 && "text-fg-faint")}>
              <span className="tnum font-mono">{working}</span> working
            </span>
            <Lamp state="needs" dim={waiting === 0} size={7} className="mt-1" />
            <span className={cn("[writing-mode:vertical-rl]", waiting === 0 && "text-fg-faint")}>
              <span className="tnum font-mono">{waiting}</span> need you
            </span>
          </span>
        </button>
        {open && (
          <aside
            aria-label="Agents"
            className={cn(
              "absolute top-0 right-full bottom-0 z-30 mr-2 flex w-[260px] animate-rise flex-col gap-3 rounded-2xl p-3",
              "border border-glass-line bg-glass-strong shadow-pop backdrop-blur-[24px]",
            )}
          >
            <div className="flex items-start gap-2">
              <RosterHead count={rows.length} working={working} />
              <button
                type="button"
                aria-label="Close agents"
                onClick={() => setOpen(false)}
                className="ml-auto grid size-6 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-raised hover:text-fg"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </div>
            <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2 pb-6 scroll-fade">
              <RosterList rows={rows} org={org} />
            </div>
          </aside>
        )}
      </div>
    </>
  );
}

function RosterHead({ count, working }: { count: number; working: number }) {
  return (
    <div className="flex items-baseline gap-2 px-1">
      <h2 className="text-base font-semibold">Agents</h2>
      <span className="tnum font-mono text-xs text-fg-faint">
        {working}/{count} working
      </span>
    </div>
  );
}
