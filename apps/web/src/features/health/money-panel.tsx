import { hoursWord, type MoneyOrg, type MoneyStatus, moneyWord, PRIVATE } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { useMoney, useSetMoney } from "@/lib/scorecard-queries";
import { useOrgs } from "@/lib/studio-queries";
import { EconomicsTable } from "./economics-table";

/** A money field: empty means not set. Saves on leaving the field, only when it changed. */
function RateField({
  label,
  value,
  onSave,
}: {
  label: string;
  value: number | undefined;
  onSave: (next: number | null) => void;
}) {
  return (
    <Input
      aria-label={label}
      type="number"
      min={0}
      inputMode="decimal"
      placeholder="not set"
      defaultValue={value ?? ""}
      key={value ?? "none"}
      className="h-7 w-24 text-right font-mono"
      onBlur={(e) => {
        const raw = e.currentTarget.value.trim();
        const next = raw === "" ? null : Number(raw);
        if (next !== null && (!Number.isFinite(next) || next < 0)) return;
        if ((next ?? undefined) !== value) onSave(next);
      }}
    />
  );
}

function Ceiling({ money }: { money: MoneyStatus }) {
  const set = useSetMoney();
  const ceiling = money.ceilingUsd;
  const pct = ceiling === undefined ? 0 : Math.min(100, (money.spentUsd / ceiling) * 100);
  const pace =
    ceiling !== undefined && money.projectedUsd !== undefined ? (money.projectedUsd / ceiling) * 100 : 0;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className={cn("tnum text-base", money.held ? "text-red" : "text-fg-soft")}>{money.line}</p>
      {ceiling !== undefined && (
        <div
          role="img"
          aria-label={`${Math.round(pct)}% of the monthly ceiling spent`}
          className="relative h-1.5 w-full max-w-[420px] overflow-hidden rounded-full bg-field"
        >
          <div
            className={cn("h-full rounded-full", money.held ? "bg-red" : "bg-accent")}
            style={{ width: `${pct}%` }}
          />
          {pace > pct && pace < 100 && (
            <div className="absolute top-0 h-full w-px bg-fg-faint" style={{ left: `${pace}%` }} />
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-fg-muted">
        <label htmlFor="money-ceiling">Monthly ceiling</label>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true">$</span>
          <RateField
            label="Monthly ceiling in dollars"
            value={money.savedCeilingUsd}
            onSave={(next) => set.mutate({ ceilingUsd: next })}
          />
        </span>
        <span className="text-fg-faint">
          {money.held
            ? "Reached: nothing new starts until you raise it or the month ends. Running work continues."
            : "Holds new starts when reached. Running work continues."}
        </span>
        {money.ceilingUsd !== undefined &&
          money.savedCeilingUsd !== undefined &&
          money.ceilingUsd > money.savedCeilingUsd && (
            <span className="text-fg-faint">Raised to {moneyWord(money.ceilingUsd)} for this month.</span>
          )}
      </div>
      {set.isError && (
        <p role="alert" className="text-sm text-red">
          {describeError(set.error)}
        </p>
      )}
    </div>
  );
}

function PnlRow({ row, name }: { row: MoneyOrg; name: string }) {
  const set = useSetMoney();
  return (
    <tr>
      <th scope="row" className="max-w-[160px] truncate px-2 py-1.5 text-left font-medium">
        {name}
      </th>
      <td className="tnum px-2 py-1.5 text-right font-mono text-fg-soft">{moneyWord(row.spentUsd)}</td>
      <td className="px-2 py-1 text-right">
        <RateField
          label={`${name}: retainer per month in dollars`}
          value={row.rates.retainerUsd}
          onSave={(next) => set.mutate({ rates: { org: row.org, retainerUsd: next } })}
        />
      </td>
      <td className="px-2 py-1 text-right">
        <RateField
          label={`${name}: your hourly rate in dollars`}
          value={row.rates.hourlyUsd}
          onSave={(next) => set.mutate({ rates: { org: row.org, hourlyUsd: next } })}
        />
      </td>
      <td className="tnum px-2 py-1.5 text-right font-mono text-fg-soft">
        {row.minutesSaved === 0 ? "n/a" : hoursWord(row.minutesSaved)}
        {row.savedUsd !== undefined && <span className="text-fg-faint"> ({moneyWord(row.savedUsd)})</span>}
      </td>
      <td
        className={cn(
          "tnum px-2 py-1.5 text-right font-mono",
          row.marginUsd === undefined ? "text-fg-faint" : row.marginUsd < 0 ? "text-red" : "text-fg-soft",
        )}
      >
        {row.marginUsd === undefined ? "n/a" : moneyWord(row.marginUsd)}
      </td>
    </tr>
  );
}

/**
 * Money this month: everything majhi spent against the one monthly ceiling, and per workspace the
 * spend beside what the client pays and the time saved is worth. A rate you did not enter shows as
 * "n/a"; nothing is guessed.
 */
export function MoneyPanel() {
  const query = useMoney();
  const orgs = useOrgs().data ?? [];
  const [open, setOpen] = useState(false);
  const money = query.data;
  const name = (org: string) => (org === PRIVATE ? "Private" : (orgs.find((o) => o.id === org)?.name ?? org));
  const rows =
    money?.orgs.filter((o) => o.spentUsd > 0 || o.rates.retainerUsd !== undefined || o.minutesSaved > 0) ??
    [];
  return (
    <section
      aria-label="Money this month"
      className={cn("flex shrink-0 flex-col gap-3 rounded-2xl px-4 py-3", GLASS)}
    >
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold">Money this month</h2>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? "Hide profit and loss" : "Profit and loss"}
        </Button>
      </div>
      {money === undefined ? (
        query.isError ? (
          <p role="alert" className="text-sm text-red">
            {describeError(query.error)}
          </p>
        ) : (
          <Skeleton className="h-10 w-[360px] max-w-full" />
        )
      ) : (
        <Ceiling money={money} />
      )}
      {open && money && <EconomicsTable />}
      {open && money && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] border-collapse text-sm">
            <caption className="pb-1 text-left text-xs text-fg-faint">
              Rates are yours to enter. With none, a workspace shows its spend only.
            </caption>
            <thead>
              <tr className="border-b border-line-strong text-xs font-medium text-fg-faint">
                <th scope="col" className="px-2 py-1 text-left">
                  Workspace
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  Spent
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  Retainer per month
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  Your hour
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  Time saved
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  Retainer less spend
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <PnlRow key={row.org} row={row} name={name(row.org)} />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-2 text-fg-faint">
                    Nothing spent this month.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
