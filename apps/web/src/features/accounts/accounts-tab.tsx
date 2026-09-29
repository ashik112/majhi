import type { AccountView, ToolInfo } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { StatusDot, TONE_TEXT } from "@/components/ui/status-dot";
import type { OkAgent } from "@/features/agents/model";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import {
  useAccountHealth,
  useAccounts,
  useAgents,
  useOrgs,
  useRemoveAccount,
  useStartLogin,
  useTools,
} from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";
import { AccountDetails } from "./account-details";
import { AccountProgress, AddAccountFlow, type ProgressStage } from "./add-account-flow";
import { HealthDialog } from "./health-dialog";
import { orgLabel, statusInfo, usageLines } from "./model";
import { UsedByChips } from "./used-by-chips";
import { agentsByAccount, type MissingAccount, missingAccounts } from "./used-by-model";

type Dialog =
  | { kind: "health"; account: AccountView }
  | { kind: "signin"; account: AccountView }
  | { kind: "remove"; account: AccountView };

export function AccountsTab() {
  const accounts = useAccounts();
  const orgs = useOrgs();
  const tools = useTools();
  const navigate = useNavigate();
  const agents = useAgents();
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const now = useNow(30_000);

  const rows = accounts.data ?? [];
  const entries = agents.data ?? [];
  const usedBy = agentsByAccount(entries);
  const missing = missingAccounts(
    entries,
    rows.map((a) => a.id),
  );
  const selected = rows.find((a) => a.id === selectedId);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-5">
        <div className="flex items-center gap-3">
          <h2 className="text-md font-semibold">Accounts</h2>
          <Button
            className="ml-auto"
            variant="primary"
            onClick={() => {
              setSelectedId(undefined);
              setAdding(true);
            }}
            aria-expanded={adding}
          >
            <Plus aria-hidden="true" />
            Add account
          </Button>
        </div>

        {accounts.isError && (
          <p role="alert" className="text-base text-red">
            Could not load accounts: {describeError(accounts.error)}
          </p>
        )}
        {accounts.isSuccess && rows.length === 0 && (
          <p className="text-base text-fg-muted">
            No accounts yet. Add one to sign in to Claude Code or Codex, or paste an API key.
          </p>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line-strong">
            <table className="w-full min-w-[980px] border-collapse text-left text-base">
              <caption className="sr-only">Accounts</caption>
              <thead>
                <tr className="border-b border-line-strong text-sm text-fg-faint">
                  <Th>Account</Th>
                  <Th>Tool</Th>
                  <Th>Org</Th>
                  <Th>Agents</Th>
                  <Th>Status</Th>
                  <Th>Usage</Th>
                  <Th>Used by</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    toolName={toolName(tools.data, account.tool)}
                    org={orgLabel(account.org, orgs.data ?? [])}
                    now={now}
                    usedBy={usedBy.get(account.id) ?? []}
                    selected={selected?.id === account.id}
                    onSelect={() => {
                      setAdding(false);
                      setSelectedId(account.id);
                    }}
                    onAction={(kind) => setDialog({ kind, account })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <MissingAccounts missing={missing} />
      </div>

      {selected && !adding && (
        <AccountDetails
          account={selected}
          tool={tools.data?.find((t) => t.id === selected.tool)}
          orgs={orgs.data ?? []}
          agents={entries}
          now={now}
          onClose={() => setSelectedId(undefined)}
        />
      )}

      {adding && (
        <aside
          aria-label="Add an account"
          className="flex w-[400px] shrink-0 flex-col gap-4 overflow-auto border-l border-line-strong p-5"
        >
          <div className="flex items-center">
            <h2 className="text-md font-semibold">Add an account</h2>
            <Button
              className="ml-auto"
              variant="ghost"
              size="icon-sm"
              aria-label="Close add account"
              onClick={() => setAdding(false)}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          <AddAccountFlow
            renderDone={(accountId, addAnother) => (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    setAdding(false);
                    void navigate({
                      to: "/studio/$tab",
                      params: { tab: "agents" },
                      search: { account: accountId },
                    });
                  }}
                >
                  Create an agent on this account
                </Button>
                <Button onClick={addAnother}>Add another account</Button>
              </div>
            )}
          />
        </aside>
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
      {dialog?.kind === "remove" && <RemoveDialog account={dialog.account} onClose={() => setDialog(null)} />}
    </div>
  );
}

function toolName(tools: ToolInfo[] | undefined, id: string): string {
  return tools?.find((t) => t.id === id)?.name ?? id;
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-3 py-2 font-normal">
      {children}
    </th>
  );
}

function AccountRow({
  account,
  toolName,
  org,
  now,
  usedBy,
  selected,
  onSelect,
  onAction,
}: {
  account: AccountView;
  toolName: string;
  org: { name: string; color?: string };
  now: number;
  usedBy: readonly OkAgent[];
  selected: boolean;
  onSelect: () => void;
  onAction: (kind: Dialog["kind"]) => void;
}) {
  const status = statusInfo(account.status);
  const usage = usageLines(account.usage, now);
  return (
    <tr
      className={cn("border-b border-line last:border-b-0 hover:bg-raised/40", selected && "bg-selected/60")}
    >
      <th scope="row" className="px-3 py-2.5 font-mono text-base font-normal">
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          className="cursor-pointer rounded-xs text-left font-mono hover:underline"
        >
          {account.id}
        </button>
        <span className="block font-sans text-sm text-fg-faint">
          {account.auth === "login" ? "Signed in" : "API key"}
        </span>
      </th>
      <td className="px-3 py-2.5 text-fg-soft">{toolName}</td>
      <td className="px-3 py-2.5 text-fg-soft">
        <span className="inline-flex items-center gap-2">
          {org.color && (
            <span aria-hidden="true" className="size-2 rounded-xs" style={{ backgroundColor: org.color }} />
          )}
          {org.name}
        </span>
      </td>
      <td className="px-3 py-2.5 text-fg-soft tabular-nums">{plural(account.agentCount, "agent")}</td>
      <td className="px-3 py-2.5">
        <span className={cn("inline-flex items-center gap-2", TONE_TEXT[status.tone])}>
          <StatusDot tone={status.tone} />
          {status.label}
        </span>
        {account.signedInAs && (
          <span className="block font-mono text-sm text-fg-faint">{account.signedInAs}</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-fg-soft">
        {usage.length === 0 ? (
          <span className="text-fg-faint">No usage yet</span>
        ) : (
          usage.map((line) => (
            <span key={line} className="block text-sm">
              {line}
            </span>
          ))
        )}
      </td>
      <td className="px-3 py-2.5">
        <UsedByChips agents={usedBy} />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Health check ${account.id}`}
            onClick={() => onAction("health")}
          >
            Health check
          </Button>
          {account.auth === "login" && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Sign in again ${account.id}`}
              onClick={() => onAction("signin")}
            >
              Sign in again
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${account.id}`}
            onClick={() => onAction("remove")}
          >
            Remove
          </Button>
        </div>
      </td>
    </tr>
  );
}

/** Agent files that name an account that does not exist, so broken references are visible. */
function MissingAccounts({ missing }: { missing: readonly MissingAccount[] }) {
  if (missing.length === 0) return null;
  return (
    <section
      aria-label="Missing accounts"
      className="flex flex-col gap-1.5 rounded-lg border border-red-line bg-red-wash px-4 py-3"
    >
      <h3 className="text-base font-medium text-red">Missing accounts</h3>
      <p className="text-sm text-fg-muted">
        These agents name an account that does not exist. Pick another account for them in Agents.
      </p>
      <ul className="flex flex-col gap-1">
        {missing.map((m) => (
          <li key={m.account} className="text-sm text-fg-soft">
            <span className="font-mono">{m.account}</span>
            <span className="text-fg-faint">, used by </span>
            <span className="font-mono">{m.agents.map((a) => `@${a}`).join(", ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HealthAccountDialog({ account, onClose }: { account: AccountView; onClose: () => void }) {
  const check = useAccountHealth();
  return (
    <HealthDialog
      title={`Health check: ${account.id}`}
      run={async () => (await check.mutateAsync(account.id)).health}
      onClose={onClose}
    />
  );
}

function RemoveDialog({ account, onClose }: { account: AccountView; onClose: () => void }) {
  const remove = useRemoveAccount();
  return (
    <ConfirmDialog
      title={`Remove ${account.id}?`}
      body="This deletes the account's config home on this machine. You will need to sign in again to use it later."
      confirmLabel="Remove account"
      busy={remove.isPending}
      error={remove.isError ? describeError(remove.error) : undefined}
      onCancel={onClose}
      onConfirm={() => remove.mutate(account.id, { onSuccess: onClose })}
    />
  );
}

function SignInAgainDialog({
  account,
  tool,
  onClose,
}: {
  account: AccountView;
  tool: ToolInfo | undefined;
  onClose: () => void;
}) {
  const login = useStartLogin();
  const [stage, setStage] = useState<ProgressStage>({ kind: "checking", accountId: account.id });
  const hint = tool?.loginHint ?? "";

  // Start once on open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a single run per open; the mutation object changes every render
  useEffect(() => {
    let live = true;
    login.mutateAsync(account.id).then(
      (started) =>
        live &&
        setStage({
          kind: "login",
          accountId: account.id,
          loginHint: hint,
          terminalId: started.terminalId,
          command: started.command,
          state: { phase: "running" },
        }),
      (error) =>
        live &&
        setStage({
          kind: "stuck",
          accountId: account.id,
          mode: "login",
          loginHint: hint,
          message: describeError(error),
        }),
    );
    return () => {
      live = false;
    };
  }, [account.id]);

  const signedIn = stage.kind === "login" && stage.state.phase === "signed-in";
  const ok = signedIn || (stage.kind === "result" && stage.health.ok);

  return (
    <Modal label={`Sign in again: ${account.id}`} onClose={onClose} className="w-[560px]">
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-md font-semibold">Sign in again: {account.id}</h2>
        {ok ? (
          <p role="status" className="text-base text-green">
            Signed in and healthy.
          </p>
        ) : (
          <AccountProgress stage={stage} setStage={setStage} />
        )}
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            {ok ? "Done" : "Close"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
