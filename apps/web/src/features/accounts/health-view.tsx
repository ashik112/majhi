import type { AccountView, ToolInfo, UsageBreakdown, UsageTotals } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Dot, toneText } from "@/components/ui/status-dot";
import { UsageBar } from "@/components/ui/usage-bar";
import { agentState, entryId, groupAgents, type OkAgent } from "@/features/agents/model";
import { ChecksSection } from "@/features/health/checks-section";
import { CostText } from "@/features/usage/cost";
import { TokensSection } from "@/features/usage/tokens-section";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo, formatTokens, plural } from "@/lib/format";
import { opsKeys } from "@/lib/ops-queries";
import { useOrgFilter } from "@/lib/org-filter";
import { PAGE_PATH } from "@/lib/pages";
import { useAccountHealth, useAccounts, useAgents, useOrgs, useTools } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useUsageBreakdown } from "@/lib/usage-queries";
import { useNow } from "@/lib/use-now";
import { authInfo, barTone, formatPct, orgLabel, resetLabel, statusText } from "./model";

const COLUMNS = "grid-cols-[170px_110px_110px_minmax(0,1fr)_minmax(0,1fr)_190px]";

/** Health and usage: every account with its meters, every agent with what it is doing. */
export function HealthView() {
  const accounts = useAccounts();
  const agents = useAgents();
  const orgs = useOrgs();
  const tools = useTools();
  const tasks = useTasks();
  const now = useNow(30_000);
  const { org: orgFilter } = useOrgFilter();
  const navigate = useNavigate();
  const check = useCheckAll(accounts.data ?? []);
  const apiKeys = (accounts.data ?? []).some((a) => a.auth === "api-key");
  const today = useUsageBreakdown({ by: "account", range: "today", limit: 500 }, apiKeys);
  const week = useUsageBreakdown({ by: "account", range: "week", limit: 500 }, apiKeys);

  const all = accounts.data ?? [];
  const entries = agents.data ?? [];
  const rows = orgFilter === undefined ? all : all.filter((a) => a.org === orgFilter);
  const okAgents = entries.filter((e): e is OkAgent => e.status === "ok");
  const agentRows =
    orgFilter === undefined ? okAgents : okAgents.filter((e) => e.agent.frontmatter.scope === orgFilter);
  const groups = groupAgents(entries, orgs.data ?? []);
  const scopeName = (scope: string) => groups.find((g) => g.scope === scope)?.label ?? scope;
  const newest = all.reduce<string | undefined>((best, a) => {
    const at = a.lastHealth?.checkedAt;
    return at && (best === undefined || at > best) ? at : best;
  }, undefined);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Health and usage"
        subtitle={
          <>
            Usage limits belong to accounts, so several agents on one account share one meter.{" "}
            {newest ? `Checked ${formatAgo(newest, now)}.` : "Not checked yet."}
          </>
        }
      >
        <Button asChild size="lg">
          <PageLink page="accounts">Manage accounts</PageLink>
        </Button>
        <Button size="lg" variant="primary" disabled={check.running} onClick={() => void check.run()}>
          <RefreshCw aria-hidden="true" className={cn(check.running && "animate-spin")} />
          {check.running ? `Checking ${check.done} of ${check.total}` : "Run health check"}
        </Button>
      </PageHeader>

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-[22px] overflow-auto px-8 pt-5 pb-7">
          <span role="status" className="sr-only">
            {check.finished ? "Health check finished" : ""}
          </span>
          {check.error && (
            <p role="alert" className="text-base text-red">
              {check.error}
            </p>
          )}
          <ChecksSection
            onSignIn={(id) => void navigate({ to: PAGE_PATH.accounts, search: { account: id } })}
          />

          <section aria-labelledby="health-accounts" className="flex flex-col gap-2">
            <h2 id="health-accounts" className="text-md font-semibold">
              Accounts
            </h2>
            {accounts.isError ? (
              <p role="alert" className="text-base text-red">
                Could not load accounts: {describeError(accounts.error)}
              </p>
            ) : accounts.isPending ? (
              <RowsSkeleton rows={5} />
            ) : rows.length === 0 ? (
              <p className="text-base text-fg-muted">
                {orgFilter !== undefined ? "This org has no accounts yet. " : "No accounts yet. "}
                <PageLink page="accounts" className="underline underline-offset-2 hover:text-fg">
                  Add one in Accounts
                </PageLink>
                .
              </p>
            ) : (
              <div>
                <div className="flex flex-col gap-2">
                  <div
                    aria-hidden="true"
                    className={cn(
                      "grid gap-4 px-3.5 text-xs tracking-[0.08em] text-fg-faint uppercase",
                      COLUMNS,
                    )}
                  >
                    {["Account", "Org", "Auth", "Current window", "Weekly", "Status"].map((h) => (
                      <span key={h}>{h}</span>
                    ))}
                  </div>
                  <ul aria-label="Accounts" className="flex flex-col gap-2">
                    {rows.map((account) => (
                      <AccountRow
                        key={account.id}
                        account={account}
                        tool={tools.data}
                        org={orgLabel(account.org, orgs.data ?? []).name}
                        now={now}
                        today={totalsFor(today.data, account.id)}
                        week={totalsFor(week.data, account.id)}
                      />
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </section>

          <TokensSection />

          <section aria-labelledby="health-agents" className="flex flex-col gap-2">
            <h2 id="health-agents" className="text-md font-semibold">
              Agents
            </h2>
            {agents.isPending ? (
              <RowsSkeleton rows={2} height={56} />
            ) : agentRows.length === 0 ? (
              <p className="text-base text-fg-muted">No agents yet.</p>
            ) : (
              <ul className="grid grid-cols-3 gap-2">
                {agentRows.map((entry) => {
                  const f = entry.agent.frontmatter;
                  const state = agentState(
                    entry,
                    all.find((a) => a.id === f.account),
                    tasks.data ?? [],
                  );
                  return (
                    <li key={entryId(entry)} className="min-w-0">
                      <PageLink
                        page="agents"
                        search={{ agent: f.id }}
                        className="flex items-center gap-2.5 rounded-[10px] border border-line-strong bg-card px-3 py-2 transition-colors hover:border-line-hover hover:bg-selected"
                      >
                        <Dot tone={state.tone} size={10} />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate font-mono text-sm leading-4">@{f.id}</span>
                          <span className="truncate text-xs leading-4 text-fg-faint">
                            {[scopeName(f.scope), f.account, f.model ?? "account default", f.effort]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                        <span className={cn("ml-auto shrink-0 text-right text-xs", toneText(state.tone))}>
                          {state.label}
                        </span>
                      </PageLink>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** One account's row in a breakdown by account; undefined while it loads. */
function totalsFor(breakdown: UsageBreakdown | undefined, account: string): UsageTotals | null | undefined {
  if (!breakdown) return undefined;
  return breakdown.rows.find((r) => r.key === account)?.totals ?? null;
}

function AccountRow({
  account,
  tool,
  org,
  now,
  today,
  week,
}: {
  account: AccountView;
  tool: ToolInfo[] | undefined;
  org: string;
  now: number;
  /** API-key accounts only: tokens and cost today and this week. Null when nothing ran. */
  today: UsageTotals | null | undefined;
  week: UsageTotals | null | undefined;
}) {
  const auth = authInfo(account);
  const status = statusText(account, now);
  const usage = account.usage;
  const toolName = tool?.find((t) => t.id === account.tool)?.name ?? account.tool;
  return (
    <li
      className={cn(
        "relative grid items-center gap-4 rounded-[10px] border bg-card px-3.5 py-2 text-sm leading-4 transition-colors duration-150",
        COLUMNS,
        "border-line-strong hover:border-line-hover",
      )}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <PageLink
          page="accounts"
          search={{ account: account.id }}
          className="truncate text-left font-mono leading-4 after:absolute after:inset-0 after:rounded-[10px] focus-visible:after:outline-2 focus-visible:after:outline-blue"
        >
          {account.id}
        </PageLink>
        <span className="truncate text-xs leading-4 text-fg-faint">
          {toolName} · {plural(account.agentCount, "agent")}
        </span>
      </span>
      <span className="truncate text-fg-soft">
        <Label>Org: </Label>
        {org}
      </span>
      <span className={toneText(auth.tone)}>
        <Label>Auth: </Label>
        {auth.label}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <Label>Current window: </Label>
        {account.auth === "api-key" ? (
          <ApiKeySpend totals={today} lead="Today" />
        ) : usage?.window ? (
          <>
            <span className="tabular-nums text-fg-soft">
              {formatPct(usage.window.usedPct)}
              {usage.window.resetsAt && ` · resets ${resetLabel(usage.window.resetsAt, now)}`}
            </span>
            <UsageBar pct={usage.window.usedPct} tone={barTone(usage.window.usedPct)} />
          </>
        ) : (
          <span className="text-fg-faint">{usage?.error ? "Usage unavailable" : "No usage yet"}</span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <Label>Weekly: </Label>
        {account.auth === "api-key" ? (
          <ApiKeySpend totals={week} trail="this week" />
        ) : usage?.weekly ? (
          <>
            <span className="tabular-nums text-fg-soft">{formatPct(usage.weekly.usedPct)}</span>
            <UsageBar pct={usage.weekly.usedPct} tone={barTone(usage.weekly.usedPct)} />
          </>
        ) : (
          <span className="text-fg-faint">No usage yet</span>
        )}
      </span>
      <span className={cn("flex items-center gap-2", toneText(status.tone))}>
        <Dot tone={status.tone} />
        <span className="truncate">
          <Label>Status: </Label>
          {status.label}
        </span>
      </span>
    </li>
  );
}

/** "Today $1.20" or "$8.40 this week", with tokens under it. API-key accounts have no usage windows. */
function ApiKeySpend({
  totals,
  lead,
  trail,
}: {
  totals: UsageTotals | null | undefined;
  lead?: string;
  trail?: string;
}) {
  if (totals === undefined) return <span className="text-fg-faint">Loading</span>;
  if (totals === null || totals.turns === 0) {
    return <span className="text-fg-faint">{lead ? `${lead} $0.00` : `$0.00 ${trail ?? ""}`}</span>;
  }
  return (
    <>
      <span className="flex items-baseline gap-1 text-fg-soft">
        {lead && <span>{lead}</span>}
        <CostText totals={totals} />
        {trail && <span>{trail}</span>}
      </span>
      <span className="text-xs text-fg-faint tabular-nums">{formatTokens(totals.totalTokens)} tokens</span>
    </>
  );
}

/** The column name the header shows, read out before a cell for screen readers. */
function Label({ children }: { children: string }) {
  return <span className="sr-only">{children}</span>;
}

/** Checks every account, three at a time, and reports how far it got. Each check also refreshes the list. */
function useCheckAll(accounts: readonly AccountView[]) {
  const health = useAccountHealth();
  const client = useQueryClient();
  const [state, setState] = useState({ running: false, done: 0, total: 0, finished: false });
  const [error, setError] = useState<string>();
  const mutate = useRef(health.mutateAsync);
  mutate.current = health.mutateAsync;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  async function run() {
    const ids = accounts.map((a) => a.id);
    setError(undefined);
    setState({ running: true, done: 0, total: ids.length, finished: false });
    let next = 0;
    let failed = 0;
    let done = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        if (id === undefined) return;
        try {
          await mutate.current(id);
        } catch {
          failed += 1;
        }
        done += 1;
        if (live.current) setState((s) => ({ ...s, done }));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    // The checks list reads each account's fresh result, so it runs after them.
    await client.invalidateQueries({ queryKey: opsKeys.checks }).catch(() => undefined);
    if (!live.current) return;
    setState({ running: false, done, total: ids.length, finished: true });
    if (failed > 0) setError(`${plural(failed, "account")} could not be checked. Open them for details.`);
  }

  return { ...state, error, run };
}
