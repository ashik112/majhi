import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageLink } from "@/components/ui/page-link";
import { CostChartPanel, SpendPanel } from "@/features/usage/spend-panel";
import { cn } from "@/lib/cn";
import { formatAgo } from "@/lib/format";
import { useHealthChecks } from "@/lib/ops-queries";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts, useOrgs, useTools } from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";
import { AccountsUsage } from "./accounts-usage";
import { ChecksPanel } from "./checks-panel";
import { CleanupPanel } from "./cleanup-panel";
import { levelOf, runSummary } from "./model";
import { MoneyPanel } from "./money-panel";
import { useCheckAll } from "./use-check-all";

/**
 * Health and usage, in the order the owner needs it: what is failing (one button each), then each
 * account's usage windows and spend, then cleanup and free space. One column that scrolls inside the
 * fixed shell at every width. "Run health check" checks everything in one go, and the page runs it by
 * itself when the last full run is old.
 */
export function HealthView() {
  const accounts = useAccounts();
  const orgs = useOrgs();
  const tools = useTools();
  const checks = useHealthChecks();
  const now = useNow(30_000);
  const { org: orgFilter } = useOrgFilter();
  const check = useCheckAll(checks.data);

  const all = accounts.data ?? [];
  const rows = orgFilter === undefined ? all : all.filter((a) => a.org === orgFilter);
  const list = checks.data?.checks ?? [];
  const summary = checks.data ? runSummary(list) : "Reading the checks";
  const bad = list.some((c) => levelOf(c) !== "pass");
  const lastRun = checks.data?.lastFullRunAt;
  const progress = check.total > 0 ? `Checking ${check.done} of ${check.total}` : "Checking";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Health & usage"
        subtitle={
          check.running ? (
            <span>{progress}</span>
          ) : (
            <span>
              <span className={cn(bad && "text-red")}>{summary}</span>
              <span className="text-fg-faint">
                {lastRun ? `. Last run ${formatAgo(lastRun, now)}.` : ". Not run since majhi started."}
              </span>
            </span>
          )
        }
      >
        <Button asChild size="lg">
          <PageLink page="limits">Limits</PageLink>
        </Button>
        <Button asChild size="lg">
          <PageLink page="accounts">Manage accounts</PageLink>
        </Button>
        <Button size="lg" variant="primary" disabled={check.running} onClick={() => check.run()}>
          <RefreshCw aria-hidden="true" className={cn(check.running && "animate-spin")} />
          {check.running ? progress : "Run health check"}
        </Button>
      </PageHeader>

      <span role="status" className="sr-only">
        {check.finished ? summary : ""}
      </span>
      {check.error && (
        <p role="alert" className="mb-2 px-1 text-base text-red">
          {check.error}
        </p>
      )}

      <div
        data-testid="health-scroll"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pb-6 scroll-fade"
      >
        <ChecksPanel checking={check.running} />
        <div className="flex shrink-0 flex-col gap-3 min-[1280px]:grid min-[1280px]:min-h-[560px] min-[1280px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col gap-3">
            <AccountsUsage
              accounts={rows}
              error={accounts.error}
              pending={accounts.isPending}
              orgs={orgs.data ?? []}
              tools={tools.data}
              now={now}
              filtered={orgFilter !== undefined}
              // With no accounts the card is one short line, so it does not stretch to fill the column.
              className={cn(
                "max-h-[720px] min-[1280px]:max-h-none",
                (rows.length > 0 || accounts.isPending) && "min-[1280px]:flex-1",
              )}
            />
            <CostChartPanel org={orgFilter} />
          </div>
          <div className="flex min-h-0 flex-col gap-3">
            <SpendPanel
              org={orgFilter}
              className="min-h-[420px] max-h-[720px] min-[1280px]:min-h-0 min-[1280px]:max-h-none min-[1280px]:flex-1"
            />
          </div>
        </div>
        <MoneyPanel />
        <CleanupPanel />
      </div>
    </div>
  );
}
