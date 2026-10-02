import type { HealthCheck } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DetailPane, ListDetail, ListPane } from "@/components/ui/list-detail";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { type RosterRow, rosterRows } from "@/features/board/roster";
import { useAgentIndex } from "@/lib/agent-index";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts, useAgents, useOrgs, useRemoveAgent } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useUsageBreakdown } from "@/lib/usage-queries";
import { useSearchParam } from "@/pages/parts/url-state";
import type { AppSearch } from "@/router";
import { AgentDetail } from "./agent-detail";
import { AgentGroups } from "./agent-groups";
import { entryId, groupAgents, INVALID_GROUP, type InvalidAgent, ROOT_SCOPE, scopeForAccount } from "./model";
import { NewAgentForm } from "./new-agent-form";

/** Every agent, grouped by org on the left; the picked agent on the right, what it does first, then its settings. */
export function AgentsView() {
  const agents = useAgents();
  const accounts = useAccounts();
  const orgs = useOrgs();
  const tasks = useTasks();
  const index = useAgentIndex();
  const week = useUsageBreakdown({ by: "agent", range: "week", limit: 500 });
  const today = useUsageBreakdown({ by: "agent", range: "today", limit: 500 });
  const { org: orgFilter } = useOrgFilter();
  const [agentParam] = useSearchParam("agent");
  const [accountParam] = useSearchParam("account");
  const [creating] = useSearchParam("create");
  const navigate = useNavigate();
  /** Opens an agent, or the new-agent form of a group, in one step so the URL changes once. */
  const show = (next: { agent?: string | undefined; create?: string | undefined }) =>
    void navigate({
      to: ".",
      search: (prev: AppSearch): AppSearch => {
        const { agent: _agent, account: _account, create: _create, ...rest } = prev;
        return {
          ...rest,
          ...(next.agent !== undefined ? { agent: next.agent } : {}),
          ...(next.create !== undefined ? { create: next.create } : {}),
        };
      },
      replace: true,
    });
  const [health, setHealth] = useState<ReadonlyMap<string, HealthCheck>>(new Map());

  const entries = useMemo(() => agents.data ?? [], [agents.data]);
  const accountList = useMemo(() => accounts.data ?? [], [accounts.data]);
  const allGroups = useMemo(() => groupAgents(entries, orgs.data ?? []), [entries, orgs.data]);
  // A workspace filter keeps Root (its agents work in every workspace), that workspace, and files that
  // failed to load.
  const groups = useMemo(
    () =>
      orgFilter === undefined
        ? allGroups
        : allGroups.filter(
            (g) => g.scope === orgFilter || g.scope === ROOT_SCOPE || g.scope === INVALID_GROUP,
          ),
    [allGroups, orgFilter],
  );
  const shown = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  const lamps = useMemo(
    () =>
      new Map<string, RosterRow>(
        rosterRows([...index.values()], tasks.data ?? [], accountList, undefined).map((r) => [r.id, r]),
      ),
    [index, tasks.data, accountList],
  );

  const presetAccount = accountParam ? accountList.find((a) => a.id === accountParam) : undefined;
  // A group from the URL counts only when it exists and takes new agents.
  const createIn = allGroups.some((g) => g.scope === creating && g.canAdd) ? creating : undefined;
  const newScope = createIn ?? (presetAccount ? scopeForAccount(presetAccount) : undefined);
  const filtered = groups.find((g) => g.scope === orgFilter)?.entries[0];
  const selected =
    shown.find((e) => entryId(e) === agentParam) ?? filtered ?? groups.find((g) => g.entries[0])?.entries[0];
  const selectedId = newScope === undefined && selected ? entryId(selected) : undefined;
  const working = [...lamps.values()].filter((r) => r.lamp === "working").length;

  if (agents.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Agents" />
        <p role="alert" className="p-8 text-base text-red">
          Could not load agents: {describeError(agents.error)}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Agents"
        subtitle={
          agents.isPending
            ? "Loading agents"
            : `${plural(index.size, "agent")}, ${working === 0 ? "none" : working} working. Setup drafts them, you have the final say on every field.`
        }
      />
      {agents.isPending ? (
        <AgentsSkeleton />
      ) : (
        <ListDetail>
          <ListPane label="Agents">
            <AgentGroups
              groups={groups}
              orgs={orgs.data ?? []}
              lamps={lamps}
              selected={selectedId}
              creating={newScope}
              onSelect={(id) => show({ agent: id })}
              onNew={(scope) => show({ create: scope })}
            />
          </ListPane>
          {newScope !== undefined ? (
            <DetailPane label="New agent">
              <NewAgentForm
                key={`${newScope}:${accountParam ?? ""}`}
                scope={newScope}
                scopeLabel={allGroups.find((g) => g.scope === newScope)?.label ?? newScope}
                presetAccount={accountParam}
                onCreated={(id) => show({ agent: id })}
                onCancel={() => show({ agent: agentParam })}
              />
            </DetailPane>
          ) : selected?.status === "ok" ? (
            <AgentDetail
              key={entryId(selected)}
              entry={selected}
              agents={entries}
              accounts={accountList}
              orgs={orgs.data ?? []}
              tasks={tasks.data ?? []}
              lamp={lamps.get(entryId(selected))}
              week={week.data}
              today={today.data}
              health={health.get(entryId(selected))}
              onHealth={(id, h) => setHealth((prev) => new Map(prev).set(id, h))}
              onSelect={(id) => show({ agent: id })}
            />
          ) : selected ? (
            <InvalidAgentPanel entry={selected as InvalidAgent} onRemoved={() => show({})} />
          ) : (
            <DetailPane label="No agent">
              <div className="flex flex-col items-start gap-3 pt-6">
                <p className="text-base text-fg-muted">
                  No agents yet. A root agent can work in every workspace.
                </p>
                <Button variant="primary" onClick={() => show({ create: ROOT_SCOPE })}>
                  New root agent
                </Button>
              </div>
            </DetailPane>
          )}
        </ListDetail>
      )}
    </div>
  );
}

function AgentsSkeleton() {
  return (
    <ListDetail>
      <ListPane label="Loading agents">
        <div aria-busy="true" className="flex flex-col gap-2 p-1">
          <span className="sr-only">Loading agents</span>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11 rounded-md" />
          ))}
        </div>
      </ListPane>
      <DetailPane label="Loading">
        <div aria-hidden="true" className="flex flex-col gap-4 pt-5">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      </DetailPane>
    </ListDetail>
  );
}

/** A file in ~/.majhi/agents that did not load: shows every error so the owner can fix the file. */
function InvalidAgentPanel({ entry, onRemoved }: { entry: InvalidAgent; onRemoved: () => void }) {
  const remove = useRemoveAgent();
  const [confirm, setConfirm] = useState(false);
  return (
    <DetailPane
      label={`@${entry.id}`}
      head={
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-md font-semibold">@{entry.id}</h2>
          <Button className="ml-auto" onClick={() => setConfirm(true)}>
            Remove file
          </Button>
        </div>
      }
    >
      <div className="flex max-w-[720px] flex-col gap-4 pt-4">
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
    </DetailPane>
  );
}
