import type { AccountView, ToolInfo } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Dot, toneText } from "@/components/ui/status-dot";
import { UsageBar } from "@/components/ui/usage-bar";
import { agentState, entryId, groupAgents, type OkAgent } from "@/features/agents/model";
import { ChecksSection } from "@/features/health/checks-section";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo, plural } from "@/lib/format";
import { opsKeys } from "@/lib/ops-queries";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccountHealth, useAccounts, useAgents, useOrgs, useTools } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { AccountDetails } from "./account-details";
import { HealthAccountDialog, RemoveAccountDialog, SignInAgainDialog } from "./account-dialogs";
import { AddAccountFlow } from "./add-account-flow";
import { authInfo, barTone, formatPct, orgLabel, resetLabel, statusText } from "./model";
import { type MissingAccount, missingAccounts } from "./used-by-model";

const COLUMNS = "grid-cols-[170px_110px_110px_minmax(0,1fr)_minmax(0,1fr)_190px]";

type Dialog =
  | { kind: "health"; account: AccountView }
  | { kind: "signin"; account: AccountView }
  | { kind: "remove"; account: AccountView };

/** Health and usage: every account with its meters, every agent with what it is doing. */
export function HealthView() {
  const accounts = useAccounts();
  const agents = useAgents();
  const orgs = useOrgs();
  const tools = useTools();
  const tasks = useTasks();
  const now = useNow(30_000);
  const { org: orgFilter } = useOrgFilter();
  const [selectedId, setSelectedId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const check = useCheckAll(accounts.data ?? []);

  const all = accounts.data ?? [];
  const entries = agents.data ?? [];
  const rows = orgFilter === undefined ? all : all.filter((a) => a.org === orgFilter);
  const missing = missingAccounts(
    entries,
    all.map((a) => a.id),
  );
  const selected = all.find((a) => a.id === selectedId);
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
        <Button
          size="lg"
          onClick={() => {
            setSelectedId(undefined);
            setAdding(true);
          }}
          aria-expanded={adding}
        >
          Add account
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
            onSignIn={(id) => {
              const account = all.find((a) => a.id === id);
              if (account) setDialog({ kind: "signin", account });
            }}
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
              <EmptyAccounts filtered={orgFilter !== undefined} onAdd={() => setAdding(true)} />
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
                        selected={selectedId === account.id}
                        onSelect={() => {
                          setAdding(false);
                          setSelectedId(account.id);
                        }}
                      />
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </section>

          <MissingAccounts missing={missing} />

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
                        className="flex items-center gap-2.5 rounded-[10px] border border-line-strong bg-raised px-3 py-2 transition-colors hover:border-line-hover hover:bg-selected"
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

        <AnimatePresence>
          {(adding || selected) && (
            <m.div
              key={adding ? "add" : "details"}
              initial={{ x: 24, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 24, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="absolute inset-y-0 right-0 z-10 w-[400px] max-w-full border-l border-line-strong bg-rail shadow-pop"
            >
              {adding ? (
                <AddAccountPanel onClose={() => setAdding(false)} onDone={() => setAdding(false)} />
              ) : selected ? (
                <AccountDetails
                  account={selected}
                  tool={tools.data?.find((t) => t.id === selected.tool)}
                  orgs={orgs.data ?? []}
                  agents={entries}
                  now={now}
                  onClose={() => setSelectedId(undefined)}
                  onAction={(kind) => setDialog({ kind, account: selected })}
                />
              ) : null}
            </m.div>
          )}
        </AnimatePresence>
      </div>

      {dialog?.kind === "health" && (
        <HealthAccountDialog account={dialog.account} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "signin" && (
        <SignInAgainDialog
          account={dialog.account}
          tool={tools.data?.find((t) => t.id === dialog.account.tool)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "remove" && (
        <RemoveAccountDialog
          account={dialog.account}
          onClose={() => {
            setDialog(null);
            setSelectedId(undefined);
          }}
        />
      )}
    </div>
  );
}

function AccountRow({
  account,
  tool,
  org,
  now,
  selected,
  onSelect,
}: {
  account: AccountView;
  tool: ToolInfo[] | undefined;
  org: string;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const auth = authInfo(account);
  const status = statusText(account, now);
  const usage = account.usage;
  const toolName = tool?.find((t) => t.id === account.tool)?.name ?? account.tool;
  return (
    <li
      className={cn(
        "relative grid items-center gap-4 rounded-[10px] border bg-raised px-3.5 py-2 text-sm leading-4 transition-colors duration-150",
        COLUMNS,
        selected ? "border-line-hover bg-selected" : "border-line-strong hover:border-line-hover",
      )}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          className="cursor-pointer truncate text-left font-mono leading-4 after:absolute after:inset-0 after:rounded-[10px] focus-visible:after:outline-2 focus-visible:after:outline-blue"
        >
          {account.id}
        </button>
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
          <span className="text-xs text-fg-muted">Tokens and cost show after the first run</span>
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
        {account.auth !== "api-key" && usage?.weekly ? (
          <>
            <span className="tabular-nums text-fg-soft">{formatPct(usage.weekly.usedPct)}</span>
            <UsageBar pct={usage.weekly.usedPct} tone={barTone(usage.weekly.usedPct)} />
          </>
        ) : (
          <span className="text-fg-faint">{account.auth === "api-key" ? "" : "No usage yet"}</span>
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

/** The column name the header shows, read out before a cell for screen readers. */
function Label({ children }: { children: string }) {
  return <span className="sr-only">{children}</span>;
}

function EmptyAccounts({ filtered, onAdd }: { filtered: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line-hover px-5 py-6">
      <p className="text-base text-fg-muted">
        {filtered
          ? "This org has no accounts yet."
          : "No accounts yet. Add one to sign in to Claude Code or Codex, or paste an API key."}
      </p>
      <Button variant="primary" onClick={onAdd}>
        Add account
      </Button>
    </div>
  );
}

function AddAccountPanel({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  return (
    <aside aria-label="Add an account" className="flex h-full flex-col gap-4 overflow-auto p-5">
      <div className="flex items-center">
        <h2 className="text-md font-semibold">Add an account</h2>
        <Button
          className="ml-auto"
          variant="ghost"
          size="icon-sm"
          aria-label="Close add account"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <AddAccountFlow
        renderDone={(accountId, addAnother) => (
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="primary">
              <PageLink page="agents" search={{ account: accountId }} onClick={onDone}>
                Create an agent on this account
              </PageLink>
            </Button>
            <Button onClick={addAnother}>Add another account</Button>
          </div>
        )}
      />
    </aside>
  );
}

/** Agent files that name an account that does not exist, so broken references are visible. */
function MissingAccounts({ missing }: { missing: readonly MissingAccount[] }) {
  if (missing.length === 0) return null;
  return (
    <section
      aria-label="Missing accounts"
      className="flex flex-col gap-1.5 rounded-xl border border-red-line bg-red-wash px-4 py-3"
    >
      <h3 className="text-base font-medium text-red">Missing accounts</h3>
      <p className="text-sm text-fg-muted">
        These agents name an account that does not exist. Pick another account for them in Agents.
      </p>
      <ul className="flex flex-col gap-1">
        {missing.map((entry) => (
          <li key={entry.account} className="text-sm text-fg-soft">
            <span className="font-mono">{entry.account}</span>
            <span className="text-fg-faint">, used by </span>
            <span className="font-mono">{entry.agents.map((a) => `@${a}`).join(", ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
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
