import { DECISIONS_TASK, type UsageFilters, type UsageSummary, type UsageTotals } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { OrgBadge } from "@/components/ui/org-badge";
import { SectionLabel } from "@/components/ui/section-label";
import { Select } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { badgeLetters, formatTokens, plural } from "@/lib/format";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useAccounts, useAgents, useOrgs } from "@/lib/studio-queries";
import { useProjects } from "@/lib/task-queries";
import { useUsageBreakdown, useUsageSummary } from "@/lib/usage-queries";
import { CostText, unpricedText } from "./cost";
import { DailyChart } from "./daily-chart";
import { PriceTable } from "./price-table";

type FilterKey = "org" | "project" | "agent" | "account" | "model";

/** Tokens and cost on Health and usage: filters, today, this week, this month, 30 days, top tasks and the price table. */
export function TokensSection() {
  const { org: sidebarOrg } = useOrgFilter();
  const [filters, setFilters] = useState<UsageFilters>(() => (sidebarOrg ? { org: sidebarOrg } : {}));
  const [pricesOpen, setPricesOpen] = useState(false);
  const pricesId = useId();

  // The sidebar's org filter sets the org here too, and clears what belonged to the old org.
  useEffect(() => {
    setFilters((f) => (f.org === sidebarOrg ? f : { agent: f.agent, model: f.model, org: sidebarOrg }));
  }, [sidebarOrg]);

  const summary = useUsageSummary(filters);
  const models = useUsageBreakdown({ by: "model", range: "all", limit: 200 });
  const modelIds = (models.data?.rows ?? []).flatMap((r) => (r.key === null ? [] : [r.key]));
  const data = summary.data;
  const filtered = Object.values(filters).some((v) => v !== undefined);
  const unpriced = data ? unpricedText(data.all) : undefined;

  function openPrices() {
    setPricesOpen(true);
    requestAnimationFrame(() => document.getElementById(pricesId)?.scrollIntoView({ block: "nearest" }));
  }

  return (
    <section aria-labelledby="health-usage" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="health-usage" className="text-md font-semibold">
          Tokens and cost
        </h2>
        {data && data.all.turns > 0 && (
          <span className="flex items-baseline gap-1 text-sm text-fg-muted">
            <span>All time</span>
            <CostText totals={data.all} />
            <span>· {formatTokens(data.all.totalTokens)} tokens</span>
          </span>
        )}
        <Filters filters={filters} models={modelIds} onChange={setFilters} />
      </div>

      {summary.isError ? (
        <p role="alert" className="text-base text-red">
          Could not load tokens and cost: {describeError(summary.error)}
        </p>
      ) : !data ? (
        <RowsSkeleton rows={2} height={72} />
      ) : data.all.turns === 0 ? (
        <p className="text-base text-fg-muted">
          {filtered
            ? "No turns match these filters."
            : "No turns yet. Tokens and cost show here after an agent's first turn."}
        </p>
      ) : (
        <div
          className={cn(
            "flex flex-col gap-3 transition-opacity duration-150",
            summary.isPlaceholderData && "opacity-60",
          )}
        >
          <div className="grid grid-cols-3 gap-2">
            <TotalTile label="Today" totals={data.today} />
            <TotalTile label="This week" totals={data.week} />
            <TotalTile label="This month" totals={data.month} />
          </div>
          {unpriced && (
            <p className="text-sm text-amber">
              {unpriced}{" "}
              <button
                type="button"
                onClick={openPrices}
                className="cursor-pointer underline underline-offset-2 hover:text-amber-hover"
              >
                Set one in the price table
              </button>
              .
            </p>
          )}
          <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-2">
            <div className="rounded-[10px] border border-line-strong bg-raised px-3.5 pt-3 pb-2.5">
              <DailyChart days={data.days} />
            </div>
            <TopTasks tasks={data.topTasks} />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={pricesOpen}
          aria-controls={pricesOpen ? pricesId : undefined}
          onClick={() => setPricesOpen((o) => !o)}
          className="-ml-1 flex cursor-pointer items-center gap-1 self-start rounded-xs px-1 text-sm text-fg-muted transition-colors hover:text-fg"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("size-3.5 transition-transform duration-150", pricesOpen && "rotate-90")}
          />
          Price table
        </button>
        {pricesOpen && <PriceTable id={pricesId} models={modelIds} />}
      </div>
    </section>
  );
}

function Filters({
  filters,
  models,
  onChange,
}: {
  filters: UsageFilters;
  models: readonly string[];
  onChange: (next: UsageFilters) => void;
}) {
  const orgs = useOrgs().data ?? [];
  const projects = useProjects().data ?? [];
  const agents = useAgents().data ?? [];
  const accounts = useAccounts().data ?? [];
  const inOrg = (org: string) => filters.org === undefined || org === filters.org;

  const options: Record<FilterKey, { label: string; items: { value: string; label: string }[] }> = {
    org: { label: "Org", items: orgs.map((o) => ({ value: o.id, label: o.name })) },
    project: {
      label: "Project",
      items: projects.filter((p) => inOrg(p.org)).map((p) => ({ value: p.id, label: p.id })),
    },
    agent: {
      label: "Agent",
      items: agents.flatMap((e) =>
        e.status === "ok" ? [{ value: e.agent.frontmatter.id, label: `@${e.agent.frontmatter.id}` }] : [],
      ),
    },
    account: {
      label: "Account",
      items: accounts.filter((a) => inOrg(a.org)).map((a) => ({ value: a.id, label: a.id })),
    },
    model: { label: "Model", items: models.map((m) => ({ value: m, label: m })) },
  };

  function set(key: FilterKey, value: string) {
    const next: UsageFilters = { ...filters, [key]: value === "" ? undefined : value };
    if (key === "org") {
      next.project = undefined;
      next.account = undefined;
    }
    onChange(next);
  }

  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {(Object.keys(options) as FilterKey[]).map((key) => {
        const { label, items } = options[key];
        const value = filters[key] ?? "";
        // A value from the URL or an older list still shows, so the select never lies.
        const list =
          value !== "" && !items.some((i) => i.value === value) ? [...items, { value, label: value }] : items;
        return (
          <Select
            key={key}
            aria-label={`${label} filter`}
            value={value}
            onChange={(e) => set(key, e.target.value)}
            className="h-7 w-auto max-w-[170px] pr-7 text-sm"
          >
            <option value="">{`All ${label.toLowerCase()}s`}</option>
            {list.map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </Select>
        );
      })}
    </div>
  );
}

function TotalTile({ label, totals }: { label: string; totals: UsageTotals }) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-line-strong bg-raised px-3.5 py-2.5">
      <SectionLabel>{label}</SectionLabel>
      <CostText totals={totals} proportional className="text-lg leading-[1.25] font-semibold" />
      <span className="text-sm text-fg-muted tabular-nums">
        {formatTokens(totals.totalTokens)} tokens · {plural(totals.turns, "turn")}
      </span>
    </div>
  );
}

function TopTasks({ tasks }: { tasks: UsageSummary["topTasks"] }) {
  const orgs = useOrgs().data ?? [];
  const { org: filter } = useOrgFilter();
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-line-strong bg-raised px-3.5 py-3">
      <SectionLabel>Top tasks this month</SectionLabel>
      {tasks.length === 0 ? (
        <p className="text-sm text-fg-faint">No tasks used tokens this month.</p>
      ) : (
        <ul aria-label="Top tasks this month" className="-mx-1.5 flex flex-col">
          {tasks.map((t) => {
            const org = orgs.find((o) => o.id === t.org);
            const title = t.task === DECISIONS_TASK ? "Decisions" : (t.title ?? t.task);
            const body = (
              <>
                <OrgBadge label={badgeLetters(org?.key ?? t.org ?? "?")} color={org?.color} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-fg-soft">{title}</span>
                  <span className="truncate text-xs text-fg-faint">
                    {t.task === DECISIONS_TASK ? "Decision provider" : t.task}
                    {org ? ` · ${org.name}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <CostText totals={t.totals} className="text-sm text-fg" />
                  <span className="text-xs text-fg-faint tabular-nums">
                    {formatTokens(t.totals.totalTokens)} tokens
                  </span>
                </span>
              </>
            );
            const row = "flex items-center gap-2.5 rounded-md px-1.5 py-1.5";
            return (
              <li key={t.task}>
                {t.task === DECISIONS_TASK ? (
                  <div className={row}>{body}</div>
                ) : (
                  <Link
                    to="/t/$taskId"
                    params={{ taskId: t.task }}
                    search={orgSearch(filter)}
                    className={cn(row, "transition-colors hover:bg-selected")}
                  >
                    {body}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
