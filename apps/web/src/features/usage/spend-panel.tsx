import {
  DECISIONS_TASK,
  type UsageBreakdown,
  type UsageDimension,
  type UsageFilters,
  type UsageRange,
  type UsageTotals,
} from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { OrgBadge } from "@/components/ui/org-badge";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { badgeLetters, formatTokens, plural } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { orgSearch } from "@/lib/org-filter";
import { PAGE_PATH } from "@/lib/pages";
import { useOrgs } from "@/lib/studio-queries";
import { useUsageBreakdown, useUsageSummary } from "@/lib/usage-queries";
import { CostText, unpricedText } from "./cost";
import { DailyChart } from "./daily-chart";
import { PriceTable } from "./price-table";

type By = Extract<UsageDimension, "org" | "agent" | "model" | "project" | "task">;

const BY: readonly { value: By; label: string }[] = [
  { value: "org", label: "Org" },
  { value: "agent", label: "Agent" },
  { value: "model", label: "Model" },
  { value: "project", label: "Project" },
  { value: "task", label: "Task" },
];

const RANGES: readonly { value: UsageRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

/**
 * Tokens and cost: today, this week and this month side by side, then a breakdown by org, agent,
 * model, project or task for a range. The price table opens in a dialog.
 */
export function SpendPanel({ org, className }: { org: string | undefined; className?: string }) {
  const filters: UsageFilters = org ? { org } : {};
  const summary = useUsageSummary(filters);
  const models = useUsageBreakdown({ by: "model", range: "all", limit: 200 });
  const modelIds = (models.data?.rows ?? []).flatMap((r) => (r.key === null ? [] : [r.key]));
  const [prices, setPrices] = useState(false);
  const data = summary.data;
  const unpriced = data ? unpricedText(data.all) : undefined;

  return (
    <section
      aria-label="Tokens and cost"
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-2xl", GLASS, className)}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-1">
        <h2 className="text-base font-semibold">Tokens and cost</h2>
        {data && data.all.turns > 0 && (
          <span className="flex items-baseline gap-1 text-sm text-fg-faint">
            All time <CostText totals={data.all} className="font-mono text-fg-muted" />
          </span>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPrices(true)}>
          Prices
        </Button>
      </div>
      {summary.isError ? (
        <p role="alert" className="px-4 py-2 text-base text-red">
          Could not load tokens and cost: {describeError(summary.error)}
        </p>
      ) : !data ? (
        <div className="px-4 py-2">
          <RowsSkeleton rows={2} height={48} />
        </div>
      ) : data.all.turns === 0 ? (
        <p className="px-4 py-2 text-base text-fg-muted">
          No turns yet. Tokens and cost show here after an agent's first turn.
        </p>
      ) : (
        <>
          <div className="grid shrink-0 grid-cols-3 px-4 pt-2 pb-3">
            <Total label="Today" totals={data.today} />
            <Total label="This week" totals={data.week} />
            <Total label="This month" totals={data.month} />
          </div>
          {unpriced && (
            <p className="shrink-0 px-4 pb-2 text-sm text-amber">
              {unpriced}{" "}
              <button
                type="button"
                onClick={() => setPrices(true)}
                className="cursor-pointer underline underline-offset-2 hover:text-amber-hover"
              >
                Set one in the price table
              </button>
              .
            </p>
          )}
          <Breakdown org={org} />
        </>
      )}
      {prices && (
        <Modal label="Prices" onClose={() => setPrices(false)} className="w-[760px]">
          <div className="flex max-h-[calc(100dvh-64px)] flex-col">
            <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
              <h2 className="text-md font-semibold">Prices</h2>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close prices"
                className="ml-auto"
                onClick={() => setPrices(false)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <div className="min-h-0 overflow-y-auto overscroll-contain p-4 pb-6 scroll-fade">
              <PriceTable id="price-table" models={modelIds} className="border-0 bg-transparent p-0" />
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function Total({ label, totals }: { label: string; totals: UsageTotals }) {
  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-0.5 border-l border-line pl-3 first:border-l-0 first:pl-0"
    >
      <h3 className="text-sm font-normal text-fg-muted">{label}</h3>
      <CostText totals={totals} className="font-mono text-md font-medium text-fg" />
      <span className="tnum truncate text-xs text-fg-faint">
        {formatTokens(totals.totalTokens)} tokens · {plural(totals.turns, "turn")}
      </span>
    </section>
  );
}

/** Totals grouped by one dimension, biggest first, each with a bar of its share of the top row. */
function Breakdown({ org }: { org: string | undefined }) {
  const [by, setBy] = useState<By>(org ? "agent" : "org");
  const [range, setRange] = useState<UsageRange>("month");
  const rangeId = useId();
  const breakdown = useUsageBreakdown({ by, range, filters: org ? { org } : {}, limit: 100 });
  const rows = (breakdown.data?.rows ?? []).filter((r) => r.totals.turns > 0);
  const top = Math.max(0, ...rows.map((r) => r.totals.costUsd));
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-line">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        <Segmented label="Break down by" value={by} segments={BY} onChange={setBy} />
        <label htmlFor={rangeId} className="sr-only">
          Range
        </label>
        <Select
          id={rangeId}
          value={range}
          onChange={(e) => setRange(e.target.value as UsageRange)}
          className="ml-auto h-8 w-auto text-sm"
        >
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-6 scroll-fade">
        {breakdown.isError ? (
          <p role="alert" className="px-2 text-sm text-red">
            Could not load the breakdown: {describeError(breakdown.error)}
          </p>
        ) : !breakdown.data ? (
          <div className="px-2">
            <RowsSkeleton rows={4} height={32} />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-2 py-1 text-sm text-fg-faint">Nothing used in this range.</p>
        ) : (
          <ul aria-label={`Cost by ${by}`} className="flex flex-col">
            {rows.map((row) => (
              <BreakdownRow key={row.key ?? "none"} by={by} row={row} top={top} org={org} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BreakdownRow({
  by,
  row,
  top,
  org,
}: {
  by: By;
  row: UsageBreakdown["rows"][number];
  top: number;
  org: string | undefined;
}) {
  const share = top > 0 ? (row.totals.costUsd / top) * 100 : 0;
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <RowLabel by={by} row={row} />
        </span>
        <span aria-hidden="true" className="block h-[3px] overflow-hidden rounded-full bg-line">
          <span className="block h-full rounded-full bg-blue" style={{ width: `${Math.max(1, share)}%` }} />
        </span>
      </span>
      <span className="flex w-[104px] shrink-0 flex-col items-end">
        <CostText totals={row.totals} className="font-mono text-sm text-fg" />
        <span className="tnum text-xs text-fg-faint">{formatTokens(row.totals.totalTokens)} tokens</span>
      </span>
    </>
  );
  const cls = "flex min-w-0 items-center gap-4 rounded-md px-2 py-1.5";
  const link = rowLink(by, row.key, org);
  return (
    <li>
      {link ? (
        <Link {...link} className={cn(cls, "transition-colors hover:bg-raised")}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

/** Where a row leads: an agent to its page, a task into its room. Others stay plain. */
function rowLink(by: By, key: string | null, org: string | undefined) {
  if (key === null) return undefined;
  if (by === "agent") return { to: PAGE_PATH.agents, search: { ...orgSearch(org), agent: key } } as const;
  if (by === "task" && key !== DECISIONS_TASK)
    return { to: "/t/$taskId", params: { taskId: key }, search: orgSearch(org) } as const;
  return undefined;
}

function RowLabel({ by, row }: { by: By; row: UsageBreakdown["rows"][number] }): ReactNode {
  const orgs = useOrgs().data ?? [];
  if (row.key === null)
    return <span className="text-sm text-fg-faint">{by === "org" ? "No org" : "None"}</span>;
  if (by === "org") {
    const org = orgs.find((o) => o.id === row.key);
    return (
      <>
        <OrgBadge label={badgeLetters(org?.key ?? row.key)} color={org?.color} size="xs" />
        <span className="truncate text-sm text-fg-soft">{org?.name ?? row.label}</span>
      </>
    );
  }
  if (by === "agent") return <span className="truncate font-mono text-sm text-fg-soft">@{row.key}</span>;
  if (by === "task") {
    if (row.key === DECISIONS_TASK) return <span className="truncate text-sm text-fg-soft">Decisions</span>;
    return (
      <>
        <span className="tnum shrink-0 font-mono text-xs text-fg-muted">{row.key}</span>
        <span className="truncate text-sm text-fg-soft">{row.label !== row.key ? row.label : ""}</span>
      </>
    );
  }
  return <span className="truncate font-mono text-sm text-fg-soft">{row.key}</span>;
}

/** Cost per day for the last 30 days, in its own glass panel. */
export function CostChartPanel({ org, className }: { org: string | undefined; className?: string }) {
  const summary = useUsageSummary(org ? { org } : {});
  return (
    <section
      aria-label="Cost per day"
      className={cn("shrink-0 rounded-2xl px-4 pt-2.5 pb-2", GLASS, className)}
    >
      {summary.data ? <DailyChart days={summary.data.days} /> : <RowsSkeleton rows={1} height={150} />}
    </section>
  );
}
