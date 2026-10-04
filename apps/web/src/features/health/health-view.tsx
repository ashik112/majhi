import { useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageLink } from "@/components/ui/page-link";
import { healthCheckedAt } from "@/features/shell/model";
import { CostChartPanel, SpendPanel } from "@/features/usage/spend-panel";
import { cn } from "@/lib/cn";
import { formatAgo } from "@/lib/format";
import { useHealthChecks } from "@/lib/ops-queries";
import { useOrgFilter } from "@/lib/org-filter";
import { PAGE_PATH } from "@/lib/pages";
import { useAccounts, useOrgs, useTools } from "@/lib/studio-queries";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import { AccountsUsage } from "./accounts-usage";
import { ChecksPanel } from "./checks-panel";
import { CleanupPanel } from "./cleanup-panel";
import { E2ePanel } from "./e2e-panel";
import { checksHeadline } from "./model";
import { useCheckAll } from "./use-check-all";

/**
 * Health and usage: one status line and the checks folded to a strip, then what the owner reads every
 * day, each account's usage windows beside tokens and cost. Wide screens fit it all without scrolling;
 * narrower ones stack the panels in one column that scrolls inside the page.
 */
export function HealthView() {
  const accounts = useAccounts();
  const orgs = useOrgs();
  const tools = useTools();
  const checks = useHealthChecks();
  const now = useNow(30_000);
  const { org: orgFilter } = useOrgFilter();
  const navigate = useNavigate();
  const check = useCheckAll(accounts.data ?? []);
  // Wide screens fit every panel; narrower ones stack them in one column that scrolls.
  const wide = useMedia("(min-width: 1280px)");

  const all = accounts.data ?? [];
  const rows = orgFilter === undefined ? all : all.filter((a) => a.org === orgFilter);
  const headline = checks.data ? checksHeadline(checks.data.checks) : "Running the checks";
  const bad = headline.endsWith("to fix");
  const checkedAt = healthCheckedAt(all, checks.data?.checkedAt);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Health and usage"
        subtitle={
          <span>
            <span className={cn(bad && "text-red")}>{headline}</span>
            {checkedAt && <span className="text-fg-faint">. Checked {formatAgo(checkedAt, now)}.</span>}
          </span>
        }
      >
        <Button asChild size="lg">
          <PageLink page="limits">Limits</PageLink>
        </Button>
        <Button asChild size="lg">
          <PageLink page="accounts">Manage accounts</PageLink>
        </Button>
        <Button size="lg" variant="primary" disabled={check.running} onClick={() => void check.run()}>
          <RefreshCw aria-hidden="true" className={cn(check.running && "animate-spin")} />
          {check.running ? `Checking ${check.done} of ${check.total}` : "Run health check"}
        </Button>
      </PageHeader>

      <span role="status" className="sr-only">
        {check.finished ? "Health check finished" : ""}
      </span>
      {check.error && (
        <p role="alert" className="mb-2 px-1 text-base text-red">
          {check.error}
        </p>
      )}

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-3",
          wide ? "overflow-hidden" : "overflow-y-auto overscroll-contain pb-6 scroll-fade",
        )}
      >
        <ChecksPanel onSignIn={(id) => void navigate({ to: PAGE_PATH.accounts, search: { account: id } })} />
        <E2ePanel />
        <CleanupPanel />
        <div className="flex flex-col gap-3 min-[1280px]:grid min-[1280px]:min-h-0 min-[1280px]:flex-1 min-[1280px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col gap-3">
            <AccountsUsage
              accounts={rows}
              error={accounts.error}
              pending={accounts.isPending}
              orgs={orgs.data ?? []}
              tools={tools.data}
              now={now}
              filtered={orgFilter !== undefined}
              className="min-[1280px]:flex-1"
            />
            <CostChartPanel org={orgFilter} />
          </div>
          <div className="flex min-h-0 flex-col gap-3">
            <SpendPanel org={orgFilter} className="min-h-[420px] min-[1280px]:min-h-0 min-[1280px]:flex-1" />
          </div>
        </div>
      </div>
    </div>
  );
}
