import type { AccountView, OrgView, ToolInfo, UsageBreakdown, UsageTotals } from "@majhi/shared";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Dot, toneText } from "@/components/ui/status-dot";
import { limitUntilText, orgLabel, statusText } from "@/features/accounts/model";
import { WindowMeter } from "@/features/accounts/window-meter";
import { CostText } from "@/features/usage/cost";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatTokens, plural } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useUsageBreakdown } from "@/lib/usage-queries";

const ROW = "grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-6";

/**
 * Every account with its usage windows: the 5-hour window, the week and any per-model week, with
 * when each resets. API-key accounts have no windows, so they show what they spent today and this week.
 */
export function AccountsUsage({
  accounts,
  error,
  pending,
  orgs,
  tools,
  now,
  filtered,
  className,
}: {
  accounts: readonly AccountView[];
  error: unknown;
  pending: boolean;
  orgs: readonly OrgView[];
  tools: readonly ToolInfo[] | undefined;
  now: number;
  /** The org filter is on, so an empty list means this org has none. */
  filtered: boolean;
  className?: string;
}) {
  const apiKeys = accounts.some((a) => a.auth === "api-key");
  const today = useUsageBreakdown({ by: "account", range: "today", limit: 500 }, apiKeys);
  const week = useUsageBreakdown({ by: "account", range: "week", limit: 500 }, apiKeys);
  return (
    <section
      aria-label="Accounts"
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-2xl", GLASS, className)}
    >
      <div className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 pt-3 pb-1">
        <h2 className="text-base font-semibold">Accounts</h2>
        <p className="min-w-0 text-sm text-fg-faint">
          Limits belong to accounts, so agents on one account share its meters.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 scroll-fade">
        {error ? (
          <p role="alert" className="text-base text-red">
            Could not load accounts: {describeError(error)}
          </p>
        ) : pending ? (
          <RowsSkeleton rows={5} height={48} />
        ) : accounts.length === 0 ? (
          <p className="py-2 text-base text-fg-muted">
            {filtered ? "This workspace has no accounts yet. " : "No accounts yet. "}
            <PageLink page="accounts" className="underline underline-offset-2 hover:text-fg">
              Add one in Accounts
            </PageLink>
            .
          </p>
        ) : (
          <ul aria-label="Account usage" className="flex flex-col">
            {accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                tool={tools?.find((t) => t.id === account.tool)?.name ?? account.tool}
                org={orgLabel(account.org, orgs).name}
                now={now}
                today={totalsFor(today.data, account.id)}
                week={totalsFor(week.data, account.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** One account's row in a breakdown by account; null when it used nothing, undefined while loading. */
function totalsFor(breakdown: UsageBreakdown | undefined, account: string): UsageTotals | null | undefined {
  if (!breakdown) return undefined;
  return breakdown.rows.find((r) => r.key === account)?.totals ?? null;
}

function AccountRow({
  account,
  tool,
  org,
  now,
  today,
  week,
}: {
  account: AccountView;
  tool: string;
  org: string;
  now: number;
  today: UsageTotals | null | undefined;
  week: UsageTotals | null | undefined;
}) {
  const status = statusText(account, now);
  const usage = account.usage;
  const plan = [usage?.plan && `${usage.plan} plan`, plural(account.agentCount, "agent")].filter(Boolean);
  return (
    <li className={cn(ROW, "border-t border-line py-2 first:border-t-0")}>
      <div className="flex min-w-0 flex-col gap-1">
        <PageLink
          page="accounts"
          search={{ account: account.id }}
          className="truncate rounded-xs font-mono text-sm text-fg underline-offset-2 hover:underline"
        >
          {account.id}
        </PageLink>
        <span className="flex min-w-0 items-center gap-1.5 text-xs" title={`${tool} · ${org}`}>
          <Dot tone={status.tone} size={7} />
          <span className={cn("shrink-0", toneText(status.tone))}>{status.label}</span>
          <span className="min-w-0 truncate text-fg-faint">
            · {tool} · {org}
          </span>
        </span>
        {account.limit && (
          <span className="cursor-help truncate text-xs text-red" title={account.limit.detail}>
            {limitUntilText(account.limit, now)}
          </span>
        )}
        <span className="truncate text-xs text-fg-faint">{plan.join(" · ")}</span>
      </div>
      {account.auth === "api-key" ? (
        <>
          <Spend label="Today" totals={today} />
          <Spend label="This week" totals={week} />
        </>
      ) : (
        <>
          {usage?.window ? (
            <WindowMeter label="5 hours" window={usage.window} now={now} />
          ) : (
            <span className="text-sm text-fg-faint">
              {usage?.error ? "Usage unavailable" : "No usage read yet"}
            </span>
          )}
          <div className="flex min-w-0 flex-col gap-2">
            {usage?.weekly ? (
              <WindowMeter label="Week" window={usage.weekly} now={now} />
            ) : (
              <span className="text-sm text-fg-faint">No weekly window</span>
            )}
            {usage?.models.map((m) => (
              <WindowMeter key={m.label} label={m.label} window={m} now={now} />
            ))}
          </div>
        </>
      )}
    </li>
  );
}

/** What an API-key account spent: "$1.20" with its tokens, or $0.00 when nothing ran. */
function Spend({ label, totals }: { label: string; totals: UsageTotals | null | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-sm">
      <span className="flex items-baseline gap-2">
        <span className="text-fg-muted">{label}</span>
        {totals === undefined ? (
          <span className="text-fg-faint">Loading</span>
        ) : totals && totals.turns > 0 ? (
          <CostText totals={totals} className="font-mono text-fg" />
        ) : (
          <span className="font-mono text-fg-faint">$0.00</span>
        )}
      </span>
      {totals && totals.turns > 0 && (
        <span className="tnum text-xs text-fg-faint">{formatTokens(totals.totalTokens)} tokens</span>
      )}
    </div>
  );
}
