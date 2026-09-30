import type { AccountView, ToolInfo } from "@majhi/shared";
import { useSearch } from "@tanstack/react-router";
import { MoreHorizontal, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu } from "@/components/ui/menu";
import { PageHeader } from "@/components/ui/page-header";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Dot, toneText } from "@/components/ui/status-dot";
import { UsageBar } from "@/components/ui/usage-bar";
import type { OkAgent } from "@/features/agents/model";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts, useAgents, useOrgs, useTools } from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";
import { AccountDetails } from "./account-details";
import { HealthAccountDialog, RemoveAccountDialog, SignInAgainDialog } from "./account-dialogs";
import { AddAccountFlow } from "./add-account-flow";
import { barTone, formatPct, orgLabel, resetLabel, statusText } from "./model";
import { agentsByAccount, chipSplit, type MissingAccount, missingAccounts } from "./used-by-model";

const COLUMNS =
  "grid-cols-[minmax(0,1.3fr)_100px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_36px]";

type Dialog =
  | { kind: "health"; account: AccountView }
  | { kind: "signin"; account: AccountView }
  | { kind: "remove"; account: AccountView };

/** Accounts: every AI account, where it is used, and the way to add, check, sign in again or remove one. */
export function AccountsView() {
  const accounts = useAccounts();
  const agents = useAgents();
  const orgs = useOrgs();
  const tools = useTools();
  const now = useNow(30_000);
  const { org: orgFilter } = useOrgFilter();
  const linked = useSearch({ strict: false }) as { account?: string };
  const [selectedId, setSelectedId] = useState<string | undefined>(linked.account);
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  // A link from a banner or an org card opens that account.
  useEffect(() => {
    if (linked.account) {
      setSelectedId(linked.account);
      setAdding(false);
    }
  }, [linked.account]);

  const all = accounts.data ?? [];
  const entries = agents.data ?? [];
  const rows = orgFilter === undefined ? all : all.filter((a) => a.org === orgFilter);
  const used = agentsByAccount(entries);
  const missing = missingAccounts(
    entries,
    all.map((a) => a.id),
  );
  const selected = all.find((a) => a.id === selectedId);
  const openAdd = () => {
    setSelectedId(undefined);
    setAdding(true);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Accounts"
        subtitle="Every AI account and where it is used. Usage limits belong to accounts, so agents on one account share one meter."
      >
        <Button size="lg" variant="primary" onClick={openAdd} aria-expanded={adding}>
          Add account
        </Button>
      </PageHeader>

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-[22px] overflow-auto px-8 pt-5 pb-7">
          {accounts.isError ? (
            <p role="alert" className="text-base text-red">
              Could not load accounts: {describeError(accounts.error)}
            </p>
          ) : accounts.isPending ? (
            <RowsSkeleton rows={5} />
          ) : rows.length === 0 ? (
            <EmptyAccounts filtered={orgFilter !== undefined} onAdd={openAdd} />
          ) : (
            <div className="flex flex-col gap-2">
              <div
                aria-hidden="true"
                className={cn("grid gap-4 px-3.5 text-xs tracking-[0.08em] text-fg-faint uppercase", COLUMNS)}
              >
                {["Account", "Org", "Status", "Current window", "Weekly", "Used by", ""].map((h, i) => (
                  <span key={h || i}>{h}</span>
                ))}
              </div>
              <ul aria-label="Accounts" className="flex flex-col gap-2">
                {rows.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    tool={tools.data}
                    org={orgLabel(account.org, orgs.data ?? []).name}
                    agents={used.get(account.id) ?? []}
                    now={now}
                    selected={selectedId === account.id}
                    onSelect={() => {
                      setAdding(false);
                      setSelectedId(account.id);
                    }}
                    onAction={(kind) => setDialog({ kind, account })}
                  />
                ))}
              </ul>
            </div>
          )}
          <MissingAccounts missing={missing} />
          <p className="text-sm text-fg-faint">
            Checks and the usage overview are on{" "}
            <PageLink page="usage" className="underline underline-offset-2 hover:text-fg">
              Health and usage
            </PageLink>
            .
          </p>
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
                <AddAccountPanel
                  defaultOrg={orgFilter}
                  onClose={() => setAdding(false)}
                  onDone={() => setAdding(false)}
                />
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
  agents,
  now,
  selected,
  onSelect,
  onAction,
}: {
  account: AccountView;
  tool: ToolInfo[] | undefined;
  org: string;
  agents: readonly OkAgent[];
  now: number;
  selected: boolean;
  onSelect: () => void;
  onAction: (kind: "health" | "signin" | "remove") => void;
}) {
  const status = statusText(account, now);
  const usage = account.usage;
  const toolName = tool?.find((t) => t.id === account.tool)?.name ?? account.tool;
  const chips = chipSplit(agents);
  return (
    <li
      className={cn(
        "relative grid items-center gap-4 rounded-[10px] border bg-card px-3.5 py-2 text-sm leading-4 transition-colors duration-150",
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
          {toolName}
          {account.auth === "api-key" && " · API key"} · {plural(account.agentCount, "agent")}
        </span>
      </span>
      <span className="truncate text-fg-soft">
        <Label>Org: </Label>
        {org}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("flex items-center gap-2", toneText(status.tone))}>
          <Dot tone={status.tone} />
          <span className="truncate">
            <Label>Status: </Label>
            {status.label}
          </span>
        </span>
        {account.signedInAs && (
          <span className="truncate pl-4 font-mono text-xs text-fg-faint">{account.signedInAs}</span>
        )}
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
      <span className="flex min-w-0 flex-wrap gap-1">
        <Label>Used by: </Label>
        {agents.length === 0 ? (
          <span className="text-fg-faint">No agents</span>
        ) : (
          <>
            {chips.shown.map((a) => (
              <span
                key={a.agent.frontmatter.id}
                className="truncate rounded-xs border border-line-strong px-1.5 py-0.5 font-mono text-xs text-fg-soft"
              >
                @{a.agent.frontmatter.id}
                {a.isBoss && <span className="ml-1 font-sans text-accent-text">Boss</span>}
              </span>
            ))}
            {chips.more > 0 && <span className="text-xs text-fg-faint">+{chips.more}</span>}
          </>
        )}
      </span>
      <span className="relative z-10 flex justify-end">
        <Menu
          label={`Actions for ${account.id}`}
          icon={<MoreHorizontal aria-hidden="true" />}
          items={[
            { label: "Check now", onSelect: () => onAction("health") },
            ...(account.auth === "login"
              ? [{ label: "Sign in again", onSelect: () => onAction("signin") }]
              : []),
            { label: "Remove", tone: "danger" as const, onSelect: () => onAction("remove") },
          ]}
        />
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

/** The add-account flow in a side panel. `defaultOrg` is the org filter's, else Private. */
export function AddAccountPanel({
  defaultOrg,
  onClose,
  onDone,
}: {
  defaultOrg?: string | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
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
        defaultOrg={defaultOrg}
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
