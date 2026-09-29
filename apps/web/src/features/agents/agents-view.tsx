import type { HealthCheck } from "@majhi/shared";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { describeError } from "@/lib/errors";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts, useAgents, useOrgs, useRemoveAgent } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { useSearchParam } from "@/pages/parts/url-state";
import { AgentEditor } from "./agent-editor";
import { AgentList } from "./agent-list";
import {
  type AgentGroup,
  type AgentState,
  agentState,
  entryId,
  groupAgents,
  INVALID_GROUP,
  type InvalidAgent,
  type OkAgent,
  ROOT_SCOPE,
  scopeForAccount,
} from "./model";
import { NewAgentForm } from "./new-agent-form";
import { ScopeTabs } from "./scope-tabs";

/** Agents of every scope: tabs for the scopes, the agents of one on the left, the open agent on the right. */
export function AgentsView() {
  const agents = useAgents();
  const accounts = useAccounts();
  const orgs = useOrgs();
  const tasks = useTasks();
  const now = useNow(30_000);
  const { org: orgFilter } = useOrgFilter();
  const [agentParam, setAgentParam] = useSearchParam("agent");
  const [accountParam, setAccountParam] = useSearchParam("account");
  const [scopePick, setScopePick] = useState<string>();
  const [creating, setCreating] = useState<string>();
  const [health, setHealth] = useState<ReadonlyMap<string, HealthCheck>>(new Map());

  const entries = useMemo(() => agents.data ?? [], [agents.data]);
  const accountList = useMemo(() => accounts.data ?? [], [accounts.data]);
  const groups = useMemo(() => groupAgents(entries, orgs.data ?? []), [entries, orgs.data]);
  const states = useMemo(() => {
    const map = new Map<string, AgentState>();
    for (const entry of entries) {
      if (entry.status !== "ok") continue;
      const account = accountList.find((a) => a.id === entry.agent.frontmatter.account);
      map.set(entryId(entry), agentState(entry, account, tasks.data ?? []));
    }
    return map;
  }, [entries, accountList, tasks.data]);

  const presetAccount = accountParam ? accountList.find((a) => a.id === accountParam) : undefined;
  const picked = entries.find((e) => entryId(e) === agentParam);
  const scopeOfPicked = picked
    ? picked.status === "ok"
      ? picked.agent.frontmatter.scope
      : INVALID_GROUP
    : undefined;
  const wanted =
    creating ??
    (presetAccount ? scopeForAccount(presetAccount) : undefined) ??
    scopeOfPicked ??
    scopePick ??
    orgFilter ??
    ROOT_SCOPE;
  const group: AgentGroup = groups.find((g) => g.scope === wanted) ??
    groups[0] ?? {
      scope: ROOT_SCOPE,
      label: "Root",
      entries: [],
      canAdd: true,
    };
  const newScope = creating ?? (presetAccount ? scopeForAccount(presetAccount) : undefined);
  const selected = picked && group.entries.includes(picked) ? picked : group.entries[0];
  const selectedId = newScope === undefined && selected ? entryId(selected) : undefined;

  if (agents.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Agents" subtitle="Setup drafts them, you have the final say on every field." />
        <p role="alert" className="p-8 text-base text-red">
          Could not load agents: {describeError(agents.error)}
        </p>
      </div>
    );
  }

  function pickScope(scope: string) {
    setCreating(undefined);
    setAccountParam(undefined);
    setScopePick(scope);
    const first = groups.find((g) => g.scope === scope)?.entries[0];
    setAgentParam(first ? entryId(first) : undefined);
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Agents" subtitle="Setup drafts them, you have the final say on every field." bottom>
        {agents.isPending ? (
          <Skeleton className="mb-3.5 h-5 w-64" />
        ) : (
          <ScopeTabs groups={groups} active={group.scope} onPick={pickScope} />
        )}
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        {agents.isPending ? (
          <AgentsSkeleton />
        ) : (
          <>
            <AgentList
              group={group}
              accounts={accountList}
              health={health}
              states={states}
              selected={selectedId}
              onSelect={(id) => {
                setCreating(undefined);
                setAccountParam(undefined);
                setAgentParam(id);
              }}
              onNew={(scope) => {
                setCreating(scope);
                setAccountParam(undefined);
              }}
            />
            <div className="flex min-w-0 flex-1 flex-col overflow-auto">
              {newScope !== undefined ? (
                <NewAgentForm
                  key={`${newScope}:${accountParam ?? ""}`}
                  scope={newScope}
                  scopeLabel={groups.find((g) => g.scope === newScope)?.label ?? newScope}
                  presetAccount={accountParam}
                  onCreated={(id) => {
                    setCreating(undefined);
                    setAccountParam(undefined);
                    setAgentParam(id);
                  }}
                  onCancel={() => {
                    setCreating(undefined);
                    setAccountParam(undefined);
                  }}
                />
              ) : selected?.status === "ok" ? (
                <AgentEditor
                  key={entryId(selected)}
                  entry={selected}
                  agents={entries}
                  accounts={accountList}
                  orgs={orgs.data ?? []}
                  state={states.get(entryId(selected)) ?? { kind: "idle", label: "Idle", tone: "neutral" }}
                  now={now}
                  onHealth={(id, h) => setHealth((prev) => new Map(prev).set(id, h))}
                  onSelect={(id) => setAgentParam(id)}
                />
              ) : selected ? (
                <InvalidAgentPanel
                  entry={selected as InvalidAgent}
                  onRemoved={() => setAgentParam(undefined)}
                />
              ) : (
                <p className="p-8 text-base text-fg-muted">
                  {group.canAdd
                    ? `No agents in ${group.label} yet. Use the button on the left to add one.`
                    : "Pick an agent to edit it."}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AgentsSkeleton() {
  return (
    <>
      <div
        aria-busy="true"
        className="flex w-[278px] shrink-0 flex-col gap-2 border-r border-line-strong px-3.5 py-4"
      >
        <span className="sr-only">Loading agents</span>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
      <div aria-hidden="true" className="flex flex-1 flex-col gap-4 px-7 py-5">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-[74px] rounded-lg" />
        <Skeleton className="h-28 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
    </>
  );
}

/** A file in ~/.majhi/agents that did not load: shows every error so the owner can fix the file. */
function InvalidAgentPanel({ entry, onRemoved }: { entry: InvalidAgent; onRemoved: () => void }) {
  const remove = useRemoveAgent();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex max-w-[720px] flex-col gap-4 px-7 pt-[18px] pb-7">
      <h2 className="font-mono text-lg font-semibold">@{entry.id}</h2>
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-lg border border-red-line bg-red-wash px-4 py-3"
      >
        <p className="text-base font-medium text-red">This file has errors and did not load.</p>
        <p className="font-mono text-sm break-all text-fg-muted">{entry.file}</p>
        <ul aria-label="Errors" className="flex flex-col gap-1">
          {entry.errors.map((error) => (
            <li key={error} className="font-mono text-sm break-words text-red">
              {error}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-base text-fg-muted text-pretty">
        Fix the file in an editor. It reloads when you save it.
      </p>
      <div>
        <Button onClick={() => setConfirm(true)}>Remove file</Button>
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Remove ${entry.id}?`}
          body="This deletes the file."
          confirmLabel="Remove file"
          busy={remove.isPending}
          error={remove.isError ? describeError(remove.error) : undefined}
          onCancel={() => setConfirm(false)}
          onConfirm={() =>
            remove.mutate(entry.id, {
              onSuccess: () => {
                setConfirm(false);
                onRemoved();
              },
            })
          }
        />
      )}
    </div>
  );
}

export type { OkAgent };
