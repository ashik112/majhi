import { PERSONAL } from "@majhi/shared";
import { Plus } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { NewOrgForm } from "@/features/accounts/new-org-form";
import { ROOT_SCOPE } from "@/features/agents/model";
import { describeError } from "@/lib/errors";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts, useAgents, useOrgs, useTools } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { CARD, OrgCard, PersonalCard } from "./org-card";

/** Orgs and accounts: one card per org, the owner's personal accounts, and a way to add an org. */
export function OrgsView() {
  const orgs = useOrgs();
  const accounts = useAccounts();
  const agents = useAgents();
  const tools = useTools();
  const tasks = useTasks();
  const { org: filter } = useOrgFilter();
  const [adding, setAdding] = useState(false);

  const orgList = orgs.data ?? [];
  const accountList = accounts.data ?? [];
  const shown = filter === undefined ? orgList : orgList.filter((o) => o.id === filter);
  const personal = accountList.filter((a) => a.org === PERSONAL);
  const rootAgents = (agents.data ?? []).filter(
    (e) => e.status === "ok" && e.agent.frontmatter.scope === ROOT_SCOPE,
  ).length;
  const open = (id: string) => (tasks.data ?? []).filter((t) => t.org === id && t.status !== "done").length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Orgs and accounts"
        subtitle="An org can hold several accounts on the same tool. Agents pick one account each."
      />
      <div className="min-h-0 flex-1 overflow-auto px-8 py-[22px]">
        {orgs.isError ? (
          <p role="alert" className="text-base text-red">
            Could not load orgs: {describeError(orgs.error)}
          </p>
        ) : orgs.isPending ? (
          <div className="grid grid-cols-3 gap-5">
            <RowsSkeleton rows={1} height={360} />
            <RowsSkeleton rows={1} height={360} />
            <RowsSkeleton rows={1} height={360} />
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] items-start gap-5">
            {shown.map((org) => (
              <OrgCard
                key={org.id}
                org={org}
                accounts={accountList.filter((a) => a.org === org.id)}
                tools={tools.data}
                openTasks={open(org.id)}
              />
            ))}
            {filter === undefined && personal.length > 0 && (
              <PersonalCard accounts={personal} tools={tools.data} rootAgents={rootAgents} />
            )}
            {filter === undefined &&
              (adding ? (
                <section aria-label="New org" className={CARD}>
                  <h2 className="text-lg font-semibold">New org</h2>
                  <NewOrgForm
                    orgCount={orgList.length}
                    onCreated={() => setAdding(false)}
                    onCancel={() => setAdding(false)}
                  />
                </section>
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-hover text-base text-fg-soft transition-colors hover:border-fg-faint hover:bg-raised hover:text-fg"
                >
                  <Plus aria-hidden="true" className="size-4" />
                  New org
                </button>
              ))}
          </div>
        )}
        {orgs.isSuccess && orgList.length === 0 && (
          <p className="mt-4 text-base text-fg-muted">
            No orgs yet. An org groups the accounts, agents and projects of one company.
          </p>
        )}
      </div>
    </div>
  );
}
