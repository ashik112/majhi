import { type AccountView, currentOrgId, type OrgView, type ToolInfo } from "@majhi/shared";
import { FileWarning, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailPane, ListDetail, ListPane, ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageHeader } from "@/components/ui/page-header";
import { PageLink } from "@/components/ui/page-link";
import { Skeleton } from "@/components/ui/skeleton";
import { Dot, toneText } from "@/components/ui/status-dot";
import { type RosterRow, rosterRows } from "@/features/board/roster";
import { groupByOrg } from "@/features/repos/project-model";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { badgeLetters, plural } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts, useAgents, useOrgs, useTools } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useUsageBreakdown } from "@/lib/usage-queries";
import { useNow } from "@/lib/use-now";
import { useSearchParam } from "@/pages/parts/url-state";
import { type AccountAction, AccountDetail } from "./account-details";
import { HealthAccountDialog, RemoveAccountDialog, SignInAgainDialog } from "./account-dialogs";
import { AddAccountFlow } from "./add-account-flow";
import { formatPct, orgLabel, statusText, usageTone } from "./model";
import { type MissingAccount, missingAccounts } from "./used-by-model";

type Dialog = { kind: AccountAction; account: AccountView };

/** Accounts by org on the left; the picked account on the right with its limits, its agents and its settings. */
export function AccountsView() {
  const accounts = useAccounts();
  const agents = useAgents();
  const orgs = useOrgs();
  const tools = useTools();
  const tasks = useTasks();
  const index = useAgentIndex();
  const week = useUsageBreakdown({ by: "account", range: "week", limit: 500 });
  const now = useNow(30_000);
  const { org: orgFilter } = useOrgFilter();
  const [picked, setPicked] = useState<string | undefined>();
  const [linked, setLinked] = useSearchParam("account");
  /** The org a new account goes to, while the add form is open. `""` lets the form pick. */
  const [adding, setAdding] = useState<string>();
  // The palette's "Add account" opens the form through ?create=<org>, or ?create=1 to let the form pick.
  const [createParam, setCreateParam] = useSearchParam("create");
  // biome-ignore lint/correctness/useExhaustiveDependencies: run when the param appears, then clear it
  useEffect(() => {
    if (createParam === undefined) return;
    setAdding(createParam === "1" ? "" : createParam);
    setCreateParam(undefined);
  }, [createParam]);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const all = accounts.data ?? [];
  const orgList = orgs.data ?? [];
  const entries = agents.data ?? [];
  const accountList = useMemo(() => accounts.data ?? [], [accounts.data]);
  const lamps = useMemo(
    () =>
      new Map<string, RosterRow>(
        rosterRows([...index.values()], tasks.data ?? [], accountList, undefined).map((r) => [r.id, r]),
      ),
    [index, tasks.data, accountList],
  );
  const shown = orgFilter === undefined ? all : all.filter((a) => currentOrgId(a.org) === orgFilter);
  const groups = accountGroups(shown, orgList, orgFilter);
  const missing = missingAccounts(
    entries,
    all.map((a) => a.id),
  );
  const first = groups.find((g) => g.items[0])?.items[0];
  const selected = all.find((a) => a.id === (linked ?? picked)) ?? first;
  const select = (id: string) => {
    setAdding(undefined);
    setPicked(id);
    if (linked !== undefined) setLinked(undefined);
  };
  const openAdd = (org: string) => setAdding(org);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Accounts"
        subtitle={
          accounts.isPending
            ? "Loading accounts"
            : `${plural(all.length, "account")}. Limits belong to accounts, so agents on one account share its meters.`
        }
      />
      {accounts.isError ? (
        <p role="alert" className="p-8 text-base text-red">
          Could not load accounts: {describeError(accounts.error)}
        </p>
      ) : (
        <ListDetail>
          <ListPane
            label="Accounts"
            className="min-[1100px]:w-[300px] min-[1320px]:w-[336px]"
            footer={
              <Button
                variant="ghost"
                aria-pressed={adding !== undefined}
                className={cn("w-full justify-start", adding !== undefined && ROW_SELECTED)}
                onClick={() => openAdd(orgFilter ?? "")}
              >
                <Plus aria-hidden="true" />
                Add account
              </Button>
            }
          >
            {accounts.isPending ? (
              <div aria-busy="true" className="flex flex-col gap-2 p-1">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 rounded-md" />
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {groups.map((group) => (
                  <AccountGroup
                    key={group.org}
                    label={group.label}
                    org={orgList.find((o) => o.id === group.org)}
                    count={group.items.length}
                    creating={adding === group.org}
                    onAdd={() => openAdd(group.org)}
                  >
                    {group.items.length === 0 ? (
                      <p className="px-2 pb-1 text-sm text-fg-faint">No accounts yet.</p>
                    ) : (
                      <ul aria-label={`Accounts of ${group.label}`} className="flex flex-col gap-px">
                        {group.items.map((account) => (
                          <AccountRow
                            key={account.id}
                            account={account}
                            tools={tools.data}
                            now={now}
                            selected={adding === undefined && selected?.id === account.id}
                            onSelect={() => select(account.id)}
                          />
                        ))}
                      </ul>
                    )}
                  </AccountGroup>
                ))}
                <MissingAccounts missing={missing} />
              </div>
            )}
          </ListPane>

          {adding !== undefined ? (
            <DetailPane label="Add an account">
              <div className="flex max-w-[520px] flex-col gap-4 pt-5">
                <div className="flex items-center gap-3">
                  <h2 className="text-md font-semibold">Add an account</h2>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto"
                    aria-label="Close add account"
                    title="Close"
                    onClick={() => setAdding(undefined)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                <AddAccountFlow
                  key={adding}
                  defaultOrg={adding === "" ? orgFilter : adding}
                  renderDone={(accountId, addAnother) => (
                    <div className="flex flex-wrap gap-2">
                      <Button asChild variant="primary">
                        <PageLink page="agents" search={{ account: accountId }}>
                          Create an agent on this account
                        </PageLink>
                      </Button>
                      <Button onClick={addAnother}>Add another account</Button>
                      <Button variant="ghost" onClick={() => select(accountId)}>
                        Show the account
                      </Button>
                    </div>
                  )}
                />
              </div>
            </DetailPane>
          ) : selected ? (
            <AccountDetail
              key={selected.id}
              account={selected}
              tool={tools.data?.find((t) => t.id === selected.tool)}
              orgs={orgList}
              agents={entries}
              lamps={lamps}
              week={
                week.data ? (week.data.rows.find((r) => r.key === selected.id)?.totals ?? null) : undefined
              }
              now={now}
              onAction={(kind) => setDialog({ kind, account: selected })}
            />
          ) : accounts.isPending ? (
            <DetailPane label="Loading">
              <Skeleton className="mt-5 h-40 rounded-lg" />
            </DetailPane>
          ) : (
            <DetailPane label="No accounts">
              <div className="flex max-w-[480px] flex-col items-start gap-3 pt-6">
                <h2 className="text-md font-semibold">
                  {orgFilter === undefined ? "No accounts yet" : "This org has no accounts yet"}
                </h2>
                <p className="text-base text-fg-muted text-pretty">
                  Add one to sign in to Claude Code or Codex, or paste an API key. Agents need an account to
                  run.
                </p>
                <Button variant="primary" onClick={() => openAdd(orgFilter ?? "")}>
                  Add account
                </Button>
              </div>
            </DetailPane>
          )}
        </ListDetail>
      )}

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
          onClose={() => setDialog(null)}
          onRemoved={() => {
            setDialog(null);
            setPicked(undefined);
            setLinked(undefined);
          }}
        />
      )}
    </div>
  );
}

interface AccountGroupData {
  org: string;
  label: string;
  items: AccountView[];
}

/**
 * Accounts by org, in the orgs' own order (Private first). Every org shows, so an empty one still
 * offers its Add button; with the org filter on, only that org.
 */
function accountGroups(
  accounts: readonly AccountView[],
  orgs: readonly OrgView[],
  filter: string | undefined,
): AccountGroupData[] {
  const withOrg = accounts.map((a) => ({ ...a, org: currentOrgId(a.org) }));
  const grouped = groupByOrg(
    withOrg,
    orgs.map((o) => o.id),
  );
  const empty = orgs
    .filter((o) => (filter === undefined || o.id === filter) && !grouped.some((g) => g.org === o.id))
    .map((o) => ({ org: o.id, items: [] as AccountView[] }));
  const order = (id: string) => {
    const at = orgs.findIndex((o) => o.id === id);
    return at === -1 ? orgs.length : at;
  };
  return [...grouped, ...empty]
    .sort((a, b) => order(a.org) - order(b.org))
    .map((g) => ({ ...g, label: orgLabel(g.org, orgs).name }));
}

function AccountGroup({
  label,
  org,
  count,
  creating,
  onAdd,
  children,
}: {
  label: string;
  org: OrgView | undefined;
  count: number;
  creating: boolean;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-px">
      <div className="flex h-8 items-center gap-2 pr-0.5 pl-2">
        <OrgBadge label={badgeLetters(org?.key ?? label)} color={org?.color} size="xs" />
        <h2 className="min-w-0 truncate text-sm font-medium text-fg-soft">{label}</h2>
        <span className="tnum font-mono text-xs text-fg-faint">{count}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Add account to ${label}`}
          aria-pressed={creating}
          title={`Add account to ${label}`}
          className={cn("ml-auto", creating && "bg-selected text-fg")}
          onClick={onAdd}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
      {children}
    </section>
  );
}

const FIGURE_TEXT = { neutral: "text-fg-soft", green: "text-fg-soft", amber: "text-amber", red: "text-red" };

/** One use figure for a list row: "5h 42%", amber from 80 % and red when full. */
function Figure({ label, pct }: { label: string; pct: number }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="font-sans text-fg-faint">{label}</span>
      <span className={FIGURE_TEXT[usageTone(pct)]}>{formatPct(pct)}</span>
    </span>
  );
}

/**
 * Two lines: the id with the 5-hour and weekly use, then the status and the tool and plan. The id is
 * the button; it covers the whole row.
 */
function AccountRow({
  account,
  tools,
  now,
  selected,
  onSelect,
}: {
  account: AccountView;
  tools: readonly ToolInfo[] | undefined;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = statusText(account, now);
  const usage = account.auth === "login" ? account.usage : undefined;
  const tool = tools?.find((t) => t.id === account.tool)?.name ?? account.tool;
  const kind = account.auth === "api-key" ? "API key" : usage?.plan;
  return (
    <li
      className={cn(
        ROW,
        "min-h-[50px] flex-col justify-center gap-0.5 px-2.5 py-1.5 focus-within:bg-raised",
        selected && ROW_SELECTED,
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          onClick={onSelect}
          title={account.id}
          className={cn(
            "min-w-0 cursor-pointer truncate text-left font-mono text-sm after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent",
            selected ? "text-fg" : "text-fg-soft",
          )}
        >
          {account.id}
        </button>
        {(usage?.window || usage?.weekly) && (
          <span className="tnum ml-auto flex shrink-0 gap-2 font-mono text-xs">
            {usage.window && <Figure label="5h" pct={usage.window.usedPct} />}
            {usage.weekly && <Figure label="wk" pct={usage.weekly.usedPct} />}
          </span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <Dot tone={status.tone} size={7} />
        <span className={cn("shrink-0", toneText(status.tone))}>{status.label}</span>
        <span aria-hidden="true" className="text-fg-dim">
          ·
        </span>
        <span className="min-w-0 truncate text-fg-faint">
          {tool}
          {kind && <span className="text-fg-muted">, {kind}</span>}
        </span>
      </span>
    </li>
  );
}

/** Agent files that name an account that does not exist, so broken references are visible. */
function MissingAccounts({ missing }: { missing: readonly MissingAccount[] }) {
  if (missing.length === 0) return null;
  return (
    <section aria-label="Missing accounts" className="flex flex-col gap-1 px-2">
      <div className="flex h-8 items-center gap-2">
        <FileWarning aria-hidden="true" className="size-[18px] shrink-0 text-red" />
        <h2 className="text-sm font-medium text-red">Missing accounts</h2>
      </div>
      <p className="text-xs text-fg-muted text-pretty">
        These agents name an account that does not exist. Pick another account for them.
      </p>
      <ul className="flex flex-col gap-1 pt-1">
        {missing.map((entry) => (
          <li key={entry.account} className="flex min-w-0 flex-col text-sm">
            <span className="truncate font-mono text-fg-soft">{entry.account}</span>
            <span className="flex min-w-0 flex-wrap gap-x-1.5 text-xs text-fg-faint">
              used by
              {entry.agents.map((id) => (
                <PageLink
                  key={id}
                  page="agents"
                  search={{ agent: id }}
                  className="rounded-xs font-mono text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  @{id}
                </PageLink>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
