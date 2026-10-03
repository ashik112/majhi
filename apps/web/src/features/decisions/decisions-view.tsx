import type { OwnerDecision } from "@majhi/shared";
import { CircleCheck, Inbox } from "lucide-react";
import { useMemo } from "react";
import { Problem } from "@/components/problem";
import { Card } from "@/components/ui/card";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { PageHeader } from "@/components/ui/page-header";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useDecisions } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { DecisionRow, WorkspaceChip, workspaceOf } from "./decision-row";

/** Decisions that belong to no workspace (a sign-in, the day's autonomous budget) group under this. */
const GENERAL = "general";

interface Group {
  key: string;
  decisions: OwnerDecision[];
}

/** Groups in the order of their first decision, which the server sorted: ship and budget first, then oldest. */
function groupByWorkspace(decisions: readonly OwnerDecision[]): Group[] {
  const groups = new Map<string, Group>();
  for (const decision of decisions) {
    const key = workspaceOf(decision) ?? GENERAL;
    const group = groups.get(key) ?? { key, decisions: [] };
    group.decisions.push(decision);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * The Decisions page (`/decisions`): everything that waits for the owner, with the captain's
 * recommendation and the answers as buttons. It follows the workspace filter; with All workspaces
 * the decisions are grouped by workspace.
 */
export function DecisionsView() {
  const query = useDecisions();
  const orgs = useOrgs().data ?? [];
  const { org, setOrg } = useOrgFilter();
  const all = query.data?.decisions;
  const shown = useMemo(
    () => (all ?? []).filter((d) => org === undefined || workspaceOf(d) === org),
    [all, org],
  );
  const counts = useMemo(() => {
    const by = new Map<string, number>();
    for (const d of all ?? []) {
      const key = workspaceOf(d);
      if (key !== undefined) by.set(key, (by.get(key) ?? 0) + 1);
    }
    return by;
  }, [all]);
  const subtitle =
    all === undefined ? undefined : all.length === 0 ? "All answered." : `${all.length} waiting for you`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Decisions"
        subtitle={subtitle ?? "What waits for you, with a recommendation where the captain has one."}
      />
      {query.isError ? (
        <Problem icon={<Inbox />} title="Could not load the decisions" body={describeError(query.error)} />
      ) : all === undefined ? (
        <RowsSkeleton rows={3} height={96} />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-6 scroll-fade">
          <div className="flex w-full max-w-[920px] min-w-0 flex-col gap-3">
            {orgs.length > 1 && all.length > 0 && (
              <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
                <legend className="sr-only">Workspace</legend>
                <ChoiceChip pressed={org === undefined} onClick={() => setOrg(undefined)}>
                  All workspaces
                  <span className="tnum font-mono text-xs text-fg-faint">{all.length}</span>
                </ChoiceChip>
                {orgs
                  .filter((o) => (counts.get(o.id) ?? 0) > 0 || o.id === org)
                  .map((o) => (
                    <ChoiceChip
                      key={o.id}
                      pressed={org === o.id}
                      onClick={() => setOrg(o.id)}
                      className="max-w-[260px]"
                    >
                      <span className="min-w-0 truncate">{o.name}</span>
                      <span className="tnum font-mono text-xs text-fg-faint">{counts.get(o.id) ?? 0}</span>
                    </ChoiceChip>
                  ))}
              </fieldset>
            )}
            {shown.length === 0 ? (
              <Card className="items-center gap-2 py-12 text-center">
                <CircleCheck aria-hidden="true" className="size-6 text-lamp-done" />
                <p className="text-md font-semibold">Nothing needs you.</p>
                <p className="text-sm text-fg-muted">
                  {org === undefined || all.length === 0
                    ? "Questions, approvals and work ready to ship show up here."
                    : "Other workspaces may still have decisions."}
                </p>
              </Card>
            ) : org === undefined ? (
              groupByWorkspace(shown).map((group) => (
                <Card key={group.key} className="gap-0 p-0" aria-label={group.key}>
                  <div className="flex min-w-0 items-center gap-2 border-b border-line px-3 py-2.5">
                    {group.key === GENERAL ? (
                      <span className="text-xs font-medium text-fg-soft">Accounts and limits</span>
                    ) : (
                      <WorkspaceChip id={group.key} />
                    )}
                    <span className="tnum font-mono text-xs text-fg-faint">{group.decisions.length}</span>
                  </div>
                  {group.decisions.map((d) => (
                    <DecisionRow key={d.id} decision={d} showWorkspace={false} />
                  ))}
                </Card>
              ))
            ) : (
              <Card className="gap-0 p-0">
                {shown.map((d) => (
                  <DecisionRow key={d.id} decision={d} showWorkspace={false} />
                ))}
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
