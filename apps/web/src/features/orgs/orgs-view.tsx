import { EMPTY_TOTALS, type OrgView, type UsageTotals } from "@majhi/shared";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailPane, ListDetail, ListPane, ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { AddAccountDialog } from "@/features/accounts/add-account-dialog";
import { NewOrgForm } from "@/features/accounts/new-org-form";
import { type RosterRow, rosterRows } from "@/features/board/roster";
import { CostText } from "@/features/usage/cost";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { badgeLetters } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts, useAgents, useOrgs, useTools } from "@/lib/studio-queries";
import { useProjects, useTasks } from "@/lib/task-queries";
import { useUsageBreakdown } from "@/lib/usage-queries";
import { OrgDetail } from "./org-detail";

/** Every org on the left, Private first; the picked org on the right with its accounts, agents, projects and settings. */
export function OrgsView() {
  const orgs = useOrgs();
  const accounts = useAccounts();
  const agents = useAgents();
  const projects = useProjects();
  const tools = useTools();
  const tasks = useTasks();
  const index = useAgentIndex();
  const month = useUsageBreakdown({ by: "org", range: "month", limit: 500 });
  const { org: filter } = useOrgFilter();
  const [picked, setPicked] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [addAccountTo, setAddAccountTo] = useState<string>();

  const orgList = orgs.data ?? [];
  const accountList = accounts.data ?? [];
  const selected = orgList.find((o) => o.id === picked) ?? orgList.find((o) => o.id === filter) ?? orgList[0];
  const open = (id: string) => (tasks.data ?? []).filter((t) => t.org === id && t.status !== "done").length;
  const spent = (id: string): UsageTotals | undefined =>
    month.data ? (month.data.rows.find((r) => r.key === id)?.totals ?? EMPTY_TOTALS) : undefined;
  const lamps = useMemo(
    () =>
      new Map<string, RosterRow>(
        rosterRows([...index.values()], tasks.data ?? [], accountList, undefined).map((r) => [r.id, r]),
      ),
    [index, tasks.data, accountList],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Workspaces"
        subtitle="A workspace keeps one body of work apart: its accounts, agents and projects. Private is yours and always there."
      />
      {orgs.isError ? (
        <p role="alert" className="p-8 text-base text-red">
          Could not load orgs: {describeError(orgs.error)}
        </p>
      ) : (
        <ListDetail>
          <ListPane
            label="Workspaces"
            footer={
              <Button
                variant="ghost"
                aria-pressed={adding}
                className={cn("w-full justify-start", adding && ROW_SELECTED)}
                onClick={() => setAdding(true)}
              >
                <Plus aria-hidden="true" />
                New workspace
              </Button>
            }
          >
            {orgs.isPending ? (
              <div aria-busy="true" className="flex flex-col gap-2 p-1">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 rounded-md" />
                ))}
              </div>
            ) : (
              <ul className="flex flex-col gap-px">
                {orgList.map((org) => (
                  <li key={org.id}>
                    <OrgRow
                      org={org}
                      openTasks={open(org.id)}
                      month={spent(org.id)}
                      selected={!adding && selected?.id === org.id}
                      onSelect={() => {
                        setAdding(false);
                        setPicked(org.id);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </ListPane>
          {adding ? (
            <DetailPane label="New workspace">
              <div className="flex max-w-[480px] flex-col gap-4 pt-5">
                <div className="flex flex-col gap-1">
                  <h2 className="text-md font-semibold">New workspace</h2>
                  <p className="text-base text-fg-muted">
                    A client, a team or a side project. Its accounts, agents and projects stay apart from the
                    rest.
                  </p>
                </div>
                <NewOrgForm
                  orgCount={orgList.length}
                  onCreated={(id) => {
                    setAdding(false);
                    setPicked(id);
                  }}
                  onCancel={() => setAdding(false)}
                  className="border-0 bg-transparent p-0 [&>div:last-child]:justify-start"
                />
              </div>
            </DetailPane>
          ) : selected ? (
            <OrgDetail
              key={selected.id}
              org={selected}
              accounts={accountList.filter((a) => a.org === selected.id)}
              agents={agents.data ?? []}
              projects={(projects.data ?? []).filter((p) => p.org === selected.id)}
              tools={tools.data}
              lamps={lamps}
              openTasks={open(selected.id)}
              month={spent(selected.id)}
              onAddAccount={() => setAddAccountTo(selected.id)}
              onRenamed={setPicked}
            />
          ) : (
            <DetailPane label="Loading">
              <Skeleton className="mt-5 h-40 rounded-lg" />
            </DetailPane>
          )}
        </ListDetail>
      )}
      {addAccountTo !== undefined && (
        <AddAccountDialog org={addAccountTo} onClose={() => setAddAccountTo(undefined)} />
      )}
    </div>
  );
}

/** The org's badge and name with its task key, then how many tasks are open and what it cost this month. */
function OrgRow({
  org,
  openTasks,
  month,
  selected,
  onSelect,
}: {
  org: OrgView;
  openTasks: number;
  month: UsageTotals | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(ROW, "min-h-[50px] items-center gap-3 px-2.5 py-1.5", selected && ROW_SELECTED)}
    >
      <OrgBadge label={badgeLetters(org.key)} color={org.color} size="md" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn("min-w-0 truncate text-body font-medium", selected ? "text-fg" : "text-fg-soft")}
          >
            {org.name}
          </span>
          <span className="ml-auto shrink-0 font-mono text-xs text-fg-faint">{org.key}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1 text-xs text-fg-faint">
          <span className="tnum font-mono text-fg-muted">{openTasks}</span> open
          {month && month.turns > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <CostText totals={month} className="font-mono text-fg-muted" />
              <span>this month</span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}
