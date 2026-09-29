import { Plus } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { AddAccountDialog } from "@/features/accounts/add-account-dialog";
import { NewOrgForm } from "@/features/accounts/new-org-form";
import { describeError } from "@/lib/errors";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts, useOrgs, useTools } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { CARD, OrgCard } from "./org-card";

/** Orgs and accounts: one card per org, Private first, and a way to add an org. */
export function OrgsView() {
  const orgs = useOrgs();
  const accounts = useAccounts();
  const tools = useTools();
  const tasks = useTasks();
  const { org: filter } = useOrgFilter();
  const [adding, setAdding] = useState(false);
  const [addAccountTo, setAddAccountTo] = useState<string>();

  const orgList = orgs.data ?? [];
  const accountList = accounts.data ?? [];
  const shown = filter === undefined ? orgList : orgList.filter((o) => o.id === filter);
  const open = (id: string) => (tasks.data ?? []).filter((t) => t.org === id && t.status !== "done").length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Orgs"
        subtitle="An org groups the accounts, agents and projects of one company. Private is yours and always there."
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
                onAddAccount={() => setAddAccountTo(org.id)}
              />
            ))}
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
      </div>
      {addAccountTo !== undefined && (
        <AddAccountDialog org={addAccountTo} onClose={() => setAddAccountTo(undefined)} />
      )}
    </div>
  );
}
