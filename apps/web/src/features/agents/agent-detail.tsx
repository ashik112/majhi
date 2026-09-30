import {
  type AccountView,
  type AgentEntry,
  collapseHome,
  type HealthCheck,
  type OrgView,
  type TaskSummary,
  type UsageBreakdown,
  type UsageTotals,
} from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { DetailPane } from "@/components/ui/list-detail";
import { Menu } from "@/components/ui/menu";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageLink } from "@/components/ui/page-link";
import { Dot, toneText } from "@/components/ui/status-dot";
import { statusText } from "@/features/accounts/model";
import { AccountMeters } from "@/features/accounts/window-meter";
import type { RosterRow } from "@/features/board/roster";
import { taskLamp, statusInfo as taskStatus } from "@/features/tasks/model";
import { CostText } from "@/features/usage/cost";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { badgeLetters, formatTokens, plural } from "@/lib/format";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useConfig } from "@/lib/queries";
import { useSetBoss } from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";
import { AgentHealthDialog, DuplicateDialog, RemoveAgentDialog, RenameDialog } from "./agent-dialogs";
import { AgentSettings } from "./agent-settings";
import { type OkAgent, ROOT_SCOPE, tasksOf } from "./model";

const TASKS_SHOWN = 5;

export interface AgentDetailProps {
  entry: OkAgent;
  agents: readonly AgentEntry[];
  accounts: readonly AccountView[];
  orgs: readonly OrgView[];
  tasks: readonly TaskSummary[];
  lamp: RosterRow | undefined;
  /** Tokens and cost per agent this week and today; undefined while loading. */
  week: UsageBreakdown | undefined;
  today: UsageBreakdown | undefined;
  /** The last health check run from this page. */
  health: HealthCheck | undefined;
  onHealth: (id: string, health: HealthCheck) => void;
  onSelect: (id: string | undefined) => void;
}

/** One agent: who it is, what it does now and what it costs, then its settings in sections. */
export function AgentDetail(props: AgentDetailProps) {
  const { entry, accounts, orgs, tasks, lamp, week, today } = props;
  const id = entry.agent.frontmatter.id;
  const account = accounts.find((a) => a.id === entry.agent.frontmatter.account);
  const now = useNow(30_000);
  return (
    <DetailPane label={`@${id}`} head={<Head {...props} />}>
      <div className="grid gap-x-8 gap-y-5 pt-4 pb-5 @[760px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.7fr)]">
        <Block title="Now">
          <NowBlock id={id} lamp={lamp} tasks={tasks} />
        </Block>
        <Block
          title={
            <>
              Account{" "}
              <PageLink
                page="accounts"
                search={{ account: entry.agent.frontmatter.account }}
                className="rounded-xs font-mono text-fg-soft underline-offset-2 hover:text-fg hover:underline"
              >
                {entry.agent.frontmatter.account}
              </PageLink>
            </>
          }
        >
          {account ? (
            <AccountBlock account={account} now={now} />
          ) : (
            <p className="text-sm text-red">This account does not exist. Pick another in Role and account.</p>
          )}
        </Block>
        <Block title="This week">
          <SpendBlock week={totalsFor(week, id)} today={totalsFor(today, id)} />
        </Block>
      </div>
      <AgentSettings key={id} entry={entry} agents={props.agents} accounts={accounts} orgs={orgs} />
    </DetailPane>
  );
}

/** The agent's row in a breakdown by agent: null when it used nothing, undefined while it loads. */
function totalsFor(breakdown: UsageBreakdown | undefined, id: string): UsageTotals | null | undefined {
  if (!breakdown) return undefined;
  return breakdown.rows.find((r) => r.key === id)?.totals ?? null;
}

function Block({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm text-fg-faint">{title}</h3>
      {children}
    </div>
  );
}

function Head({ entry, orgs, health, onHealth, onSelect }: AgentDetailProps) {
  const f = entry.agent.frontmatter;
  const id = f.id;
  const boss = useSetBoss();
  const home = useConfig().data?.home;
  const [dialog, setDialog] = useState<"duplicate" | "rename" | "health" | "remove" | null>(null);
  const org = orgs.find((o) => o.id === f.scope);
  const orgName = f.scope === ROOT_SCOPE ? "Root, works in every org" : (org?.name ?? f.scope);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-3">
        <AgentAvatar id={id} role={f.role} size={32} decorative ring="border-canvas" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate font-mono text-md leading-6 font-semibold">@{id}</h2>
            {entry.isBoss && <Badge tone="amber">Boss</Badge>}
            {f.origin === "setup" && <Badge tone="blue">Drafted by @setup</Badge>}
            {health && (
              <Badge tone={health.ok ? "green" : "red"}>
                {health.ok ? "Health check passed" : "Health check failed"}
              </Badge>
            )}
          </div>
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
            <span className="shrink-0">{f.role}</span>
            <span aria-hidden="true" className="text-fg-dim">
              ·
            </span>
            <OrgBadge
              label={f.scope === ROOT_SCOPE ? "RT" : badgeLetters(org?.key ?? f.scope)}
              color={f.scope === ROOT_SCOPE ? "var(--c-green)" : org?.color}
              size="xs"
            />
            <span className="shrink-0">{orgName}</span>
            <span aria-hidden="true" className="text-fg-dim">
              ·
            </span>
            <span className="min-w-0 truncate font-mono text-xs text-fg-faint" title={entry.file}>
              {home ? collapseHome(entry.file, home) : entry.file}
            </span>
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button onClick={() => setDialog("health")}>Health check</Button>
          <Menu
            label="Agent actions"
            icon={<Ellipsis aria-hidden="true" />}
            items={[
              { label: "Rename", onSelect: () => setDialog("rename") },
              { label: "Duplicate", onSelect: () => setDialog("duplicate") },
              ...(f.scope === ROOT_SCOPE && !entry.isBoss
                ? [{ label: "Make boss", onSelect: () => boss.mutate(id) }]
                : []),
              {
                label: entry.isBoss ? "Remove (the boss cannot be removed)" : "Remove",
                onSelect: () => setDialog("remove"),
                disabled: entry.isBoss,
                tone: "danger" as const,
              },
            ]}
          />
        </div>
      </div>
      {entry.isBoss && (
        <p className="sr-only">The boss cannot be removed. Make another root agent the boss first.</p>
      )}
      {boss.isError && (
        <p role="alert" className="text-sm text-red">
          Could not make {id} the boss: {describeError(boss.error)}
        </p>
      )}
      {dialog === "duplicate" && (
        <DuplicateDialog id={id} onClose={() => setDialog(null)} onDone={(newId) => onSelect(newId)} />
      )}
      {dialog === "rename" && (
        <RenameDialog id={id} onClose={() => setDialog(null)} onDone={(newId) => onSelect(newId)} />
      )}
      {dialog === "health" && (
        <AgentHealthDialog id={id} onClose={() => setDialog(null)} onHealth={onHealth} />
      )}
      {dialog === "remove" && (
        <RemoveAgentDialog id={id} onClose={() => setDialog(null)} onDone={() => onSelect(undefined)} />
      )}
    </div>
  );
}

/** The agent's state beside its lamp, then the open tasks it is on, each a link into the task. */
function NowBlock({
  id,
  lamp,
  tasks,
}: {
  id: string;
  lamp: RosterRow | undefined;
  tasks: readonly TaskSummary[];
}) {
  const { org: filter } = useOrgFilter();
  const state = lamp?.lamp ?? "idle";
  const mine = tasksOf(id, tasks);
  const working = mine.find((t) => t.working.includes(id));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="flex items-center gap-2 text-base">
        <Lamp state={state} />
        <span className={LAMP_TEXT[state]}>{lamp?.state ?? "Idle"}</span>
        {working && <span className="min-w-0 truncate text-fg-muted">on {working.id}</span>}
      </p>
      {mine.length === 0 ? (
        <p className="text-sm text-fg-faint">Not on any open task.</p>
      ) : (
        <ul aria-label={`Open tasks of @${id}`} className="-mx-1.5 flex flex-col">
          {mine.slice(0, TASKS_SHOWN).map((t) => {
            const info = taskStatus(
              t.status,
              t.pausedReason,
              t.status === "running" && t.working.length === 0,
            );
            const lit = taskLamp(t);
            return (
              <li key={t.id}>
                <Link
                  to="/t/$taskId"
                  params={{ taskId: t.id }}
                  search={orgSearch(filter)}
                  title={`${t.id}: ${t.title}`}
                  className="flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-sm transition-colors hover:bg-raised"
                >
                  <Lamp state={lit} size={7} />
                  <span className="tnum shrink-0 font-mono text-xs text-fg-muted">{t.id}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-soft">{t.title}</span>
                  <span className={cn("shrink-0 text-xs", LAMP_TEXT[lit])}>{info.label}</span>
                </Link>
              </li>
            );
          })}
          {mine.length > TASKS_SHOWN && (
            <li className="px-1.5 pt-1 text-xs text-fg-faint">
              and {plural(mine.length - TASKS_SHOWN, "more task")} on the board
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function AccountBlock({ account, now }: { account: AccountView; now: number }) {
  const status = statusText(account, now);
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <p className={cn("flex items-center gap-2 text-sm", toneText(status.tone))}>
        <Dot tone={status.tone} size={7} />
        {status.label}
        {account.usage?.plan && <span className="text-fg-faint">· {account.usage.plan} plan</span>}
      </p>
      <AccountMeters account={account} now={now} />
    </div>
  );
}

function SpendBlock({
  week,
  today,
}: {
  week: UsageTotals | null | undefined;
  today: UsageTotals | null | undefined;
}) {
  if (week === undefined) return <p className="text-sm text-fg-faint">Loading</p>;
  if (week === null || week.turns === 0)
    return <p className="text-sm text-fg-faint">Nothing used this week.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <CostText totals={week} className="font-mono text-md font-medium text-fg" />
      <span className="tnum text-sm text-fg-muted">
        <span className="font-mono">{formatTokens(week.totalTokens)}</span> tokens,{" "}
        <span className="font-mono">{week.turns}</span> {week.turns === 1 ? "turn" : "turns"}
      </span>
      <span className="flex items-baseline gap-1 text-sm text-fg-faint">
        Today
        {today && today.turns > 0 ? (
          <CostText totals={today} className="font-mono text-fg-soft" />
        ) : (
          <span className="font-mono">$0.00</span>
        )}
      </span>
    </div>
  );
}
